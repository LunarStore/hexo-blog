---
title: muduo源码阅读笔记（10、TcpConnection）
date: 2024-11-02 12:00:00
tags:
  - 高性能服务器框架
---

**Muduo源码笔记系列：**

[muduo源码阅读笔记（0、下载编译muduo）](./Start.md)

[muduo源码阅读笔记（1、同步日志）](./SynLogging.md)

[muduo源码阅读笔记（2、对C语言原生的线程安全以及同步的API的封装）](./ThreadSafeAndSync.md)

[muduo源码阅读笔记（3、线程和线程池的封装）](./ThreadAndThreadPool.md)

[muduo源码阅读笔记（4、异步日志）](./AsyncLogging.md)

[muduo源码阅读笔记（5、Channel和Poller）](./ChannelAndPoller.md)

[muduo源码阅读笔记（6、ExevntLoop和Thread）](./EvevntLoopAndThread.md)

[muduo源码阅读笔记（7、EventLoopThreadPool）](./EventLoopThreadPool.md)

[muduo源码阅读笔记（8、定时器TimerQueue）](./TimerQueue.md)

[muduo源码阅读笔记（9、TcpServer）](./TcpServer.md)

[muduo源码阅读笔记（10、TcpConnection）](./TcpConnection.md)

**前言**

本章涉及两个新模块：TcpConnection、Buffer。本文重点集中在TcpConnection上，对于Buffer会进行简单的描述。

## Buffer

Muduo的Buffer类实际上就是基于vector\<char\>实现了一个缓存区，在vector的基础上，自己封装了扩容和缩容的接口。每个TcpConnection都会自带两个Buffer，一个读缓存区和一个写缓存区。

这里只列出TcpConnection用到的接口的实现。

**提供的接口：**

<!-- more -->
```cpp
class Buffer : public muduo::copyable{
public:
    static const size_t kCheapPrepend = 8;  // 为prepend预留
    static const size_t kInitialSize = 1024;    // 默认大小

    explicit Buffer(size_t initialSize = kInitialSize)
    : buffer_(kCheapPrepend + initialSize),
        readerIndex_(kCheapPrepend),
        writerIndex_(kCheapPrepend){
        assert(readableBytes() == 0);
        assert(writableBytes() == initialSize);
        assert(prependableBytes() == kCheapPrepend);
    }
    size_t readableBytes() const
    { return writerIndex_ - readerIndex_; }

    size_t writableBytes() const
    { return buffer_.size() - writerIndex_; }

    size_t prependableBytes() const
    { return readerIndex_; }

    const char* peek() const
    { return begin() + readerIndex_; }
    //各种读写操作省略
    // ...

    
    void append(const char* /*restrict*/ data, size_t len){
        ensureWritableBytes(len);
        std::copy(data, data+len, beginWrite());
        hasWritten(len);
    }

    void ensureWritableBytes(size_t len){
        if (writableBytes() < len){
            makeSpace(len);
        }
        assert(writableBytes() >= len);
    }

    void shrink(size_t reserve){    // 缩容
        // FIXME: use vector::shrink_to_fit() in C++ 11 if possible.
        Buffer other;
        other.ensureWritableBytes(readableBytes()+reserve);
        other.append(toStringPiece());
        swap(other);
    }

    /// Read data directly into buffer.
    ///
    /// It may implement with readv(2)
    /// @return result of read(2), @c errno is saved
    ssize_t readFd(int fd, int* savedErrno);

private:

    char* begin()
    { return &*buffer_.begin(); }

    void makeSpace(size_t len){
        if (writableBytes() + prependableBytes() < len + kCheapPrepend){ // 扩容。
            // FIXME: move readable data
            buffer_.resize(writerIndex_+len);
        }else{ // 原地腾空间
            // move readable data to the front, make space inside buffer
            assert(kCheapPrepend < readerIndex_);
            size_t readable = readableBytes();
            std::copy(begin()+readerIndex_,
                    begin()+writerIndex_,
                    begin()+kCheapPrepend);
            readerIndex_ = kCheapPrepend;
            writerIndex_ = readerIndex_ + readable;
            assert(readable == readableBytes());
        }
    }

private:
  std::vector<char> buffer_;
  size_t readerIndex_;  // 读到哪里
  size_t writerIndex_;  // 写到哪里
};

```

Buffer的结构如下：

```
/// A buffer class modeled after org.jboss.netty.buffer.ChannelBuffer
///
/// @code
/// +-------------------+------------------+------------------+
/// | prependable bytes |  readable bytes  |  writable bytes  |
/// |                   |     (CONTENT)    |                  |
/// +-------------------+------------------+------------------+
/// |                   |                  |                  |
/// 0      <=      readerIndex   <=   writerIndex    <=     size
/// @endcode
```

**实现的伪代码：**

```cpp
/*
* 将sockfd上的数据读到buffer上。
*/
ssize_t Buffer::readFd(int fd, int* savedErrno){
    // saved an ioctl()/FIONREAD call to tell how much to read
    char extrabuf[65536];
    struct iovec vec[2];
    const size_t writable = writableBytes();
    vec[0].iov_base = begin()+writerIndex_;
    vec[0].iov_len = writable;
    vec[1].iov_base = extrabuf;
    vec[1].iov_len = sizeof extrabuf;
    // when there is enough space in this buffer, don't read into extrabuf.
    // when extrabuf is used, we read 128k-1 bytes at most.
    // buffer够大，只用buffer，否者buffer和extrabuf一起用
    const int iovcnt = (writable < sizeof extrabuf) ? 2 : 1;
    const ssize_t n = sockets::readv(fd, vec, iovcnt);
    if (n < 0){
        *savedErrno = errno;
    }else if (implicit_cast<size_t>(n) <= writable){
        writerIndex_ += n;
    }else{
        writerIndex_ = buffer_.size();
        append(extrabuf, n - writable); // 将extrabuf的数据append到buffer中
    }
    return n;
}

```

## TcpConnection

仔细阅读源码，结合前面的TimeQueue和Acceptor，TcpConnection的整体结构其实和这两个类差不多。内部都是维护了专门的fd的channel，实现了各种事件处理回调。只不过TcpConnection管理的是数据读写套接字，涉及的事件比较多，回调处理部分也稍稍复杂点。

**TcpConnection对象的构造：**

根据传进来的sockfd、loop，为sockfd构造一个channel，并为channel设置事件的回调处理函数，最后将sockfd设置为SO_KEEPALIVE。（TcpConnection::state_初始化为kConnecting）

代码如下：

```cpp
TcpConnection::TcpConnection(EventLoop* loop,
                             const string& nameArg,
                             int sockfd,
                             const InetAddress& localAddr,
                             const InetAddress& peerAddr)
  : loop_(CHECK_NOTNULL(loop)),
    name_(nameArg),
    state_(kConnecting),
    reading_(true),
    socket_(new Socket(sockfd)),
    channel_(new Channel(loop, sockfd)),
    localAddr_(localAddr),
    peerAddr_(peerAddr),
    highWaterMark_(64*1024*1024){

    channel_->setReadCallback(  // 读回调
        std::bind(&TcpConnection::handleRead, this, _1));
    channel_->setWriteCallback( // 写回调
        std::bind(&TcpConnection::handleWrite, this));
    channel_->setCloseCallback( // sockfd关闭回调
        std::bind(&TcpConnection::handleClose, this));
    channel_->setErrorCallback( // 错误处理回调
        std::bind(&TcpConnection::handleError, this));
    LOG_DEBUG << "TcpConnection::ctor[" <<  name_ << "] at " << this
            << " fd=" << sockfd;
    socket_->setKeepAlive(true);    // 长连接
}
```

**连接的建立：**

接着[muduo源码阅读笔记（9、TcpServer）](./TcpServer.md)。

1. 在绑定的ioloop中执行`TcpConnection::connectEstablished()`，进行连接的初始化，过程如下：

    1. 将TcpConnection::state_设置成kConnected。

    2. 将channel_的生命周期和TcpConnection绑定，以免TcpConnection被销毁后，channel的回调继续错误的被执行。

    3. 向ioloop的Poller中注册channel_并使能读事件。

    4. 调用TcpConnection::connectionCallback_回调。

    5. 连接建立完毕。

代码如下：

```cpp
void TcpConnection::connectEstablished(){
    loop_->assertInLoopThread();
    assert(state_ == kConnecting);
    setState(kConnected);
    channel_->tie(shared_from_this());
    channel_->enableReading();  // 使能读事件

    connectionCallback_(shared_from_this());
}
```

**接收数据：**

全权由读回调接收：

1. 将数据读到TcpConnection::inputBuffer_，返回值n（读到字节数）

2. 
    - n > 0，调用TcpConnection::messageCallback_处理数据
    - n == 0，说明连接关闭，调用TcpConnection::handleClose()回调。
    - n < 0，出错，调用TcpConnection::handleError处理。

代码如下：

```cpp
void TcpConnection::handleRead(Timestamp receiveTime){
    loop_->assertInLoopThread();
    int savedErrno = 0;
    ssize_t n = inputBuffer_.readFd(channel_->fd(), &savedErrno);
    if (n > 0){
        messageCallback_(shared_from_this(), &inputBuffer_, receiveTime);
    }else if (n == 0){
        handleClose();
    }else{
        errno = savedErrno;
        LOG_SYSERR << "TcpConnection::handleRead";
        handleError();
    }
}
```

**发送数据：**

主动发送：

1. 用户调用TcpConnection::send

    1. 如果正好在ioloop内，直接调用TcpConnection::sendInLoop()，否则，向ioloop的任务队列中添加TcpConnection::sendInLoop()异步回调。

    2. 执行TcpConnection::sendInLoop()
        1. 如果连接状态为kDisconnected，说明连接断开，直接返回。

        2. 先直接调用::write，能写多少是多少，触发errno == EPIPE || errno == ECONNRESET错误就直接返回。

        3. 如果写完了，异步调用一下writeCompleteCallback_回调。否者，说明底层的发送缓存满了，剩余的数据追加到outputBuffer_，并使能channel_的写事件，异步通知写outputBuffer_。当然，如果outputBuffer_积累的数据太多，达到阈值，就异步调用一下highWaterMarkCallback_。

sendInLoop代码如下：

```cpp
void TcpConnection::sendInLoop(const void* data, size_t len){
    loop_->assertInLoopThread();
    ssize_t nwrote = 0;
    size_t remaining = len; // 还剩多少没发
    bool faultError = false;
    if (state_ == kDisconnected){ // 连接断开
        LOG_WARN << "disconnected, give up writing";
        return;
    }
    // if no thing in output queue, try writing directly
    if (!channel_->isWriting() && outputBuffer_.readableBytes() == 0){ // Poller没有监听conn fd的写事件 && TcpConnection::outputBuffer_缓存没有数据等待发送（完全空闲）。

        // 尽最大努力写一次，能写多少是多少
        // 如果数据没写完，说明TCP发送缓存满，就需要向Poller注册写事件，来通知异步写，将剩余的数据写完。
        nwrote = sockets::write(channel_->fd(), data, len); 
        if (nwrote >= 0){
            remaining = len - nwrote;
            if (remaining == 0 && writeCompleteCallback_){
                loop_->queueInLoop(std::bind(writeCompleteCallback_, shared_from_this()));
            }
        }else{ // nwrote < 0
            nwrote = 0;
            if (errno != EWOULDBLOCK){
                LOG_SYSERR << "TcpConnection::sendInLoop";
                if (errno == EPIPE || errno == ECONNRESET) {// FIXME: any others?// 本端sock写关闭，但是还向sock里面写，会触发EPIPE || 连接关闭
                    faultError = true;
                }
            }
        }
    }

    assert(remaining <= len);
    if (!faultError && remaining > 0){  // TCP写缓存满，还有代写数据，只能异步写。
        size_t oldLen = outputBuffer_.readableBytes();
        if (oldLen + remaining >= highWaterMark_
            && oldLen < highWaterMark_
            && highWaterMarkCallback_){
            loop_->queueInLoop(std::bind(highWaterMarkCallback_, shared_from_this(), oldLen + remaining));
        }
        outputBuffer_.append(static_cast<const char*>(data)+nwrote, remaining);
        if (!channel_->isWriting()){
            channel_->enableWriting();
        }
    }
}
```

异步发送：

因为发送缓存区满了，所以不得不由Poller异步通知来发送数据

1. 发送缓存未满，Poller触发可写事件，调用TcpConnection::handleWrite()

    1. 保证channel_->isWriting() == true，否则什么也不做输出日志后返回。

    2. 调用::write()发送outputBuffer_数据。

    3. 如果outputBuffer_数据发送完了，取消cahnnel_的写事件，并异步调用一下writeCompleteCallback_ && 如果连接状态是kDisconnecting，执行shutdownInLoop()。关闭本端写。

handleWrite()代码如下：

```cpp
void TcpConnection::handleWrite(){
    loop_->assertInLoopThread();
    if (channel_->isWriting()){
        ssize_t n = sockets::write(channel_->fd(),
                                outputBuffer_.peek(),
                                outputBuffer_.readableBytes());
        if (n > 0){
            outputBuffer_.retrieve(n);
            if (outputBuffer_.readableBytes() == 0){
                channel_->disableWriting();
                if (writeCompleteCallback_){
                    loop_->queueInLoop(std::bind(writeCompleteCallback_, shared_from_this()));
                }
                if (state_ == kDisconnecting){
                    shutdownInLoop();
                }
            }
        }else{
            LOG_SYSERR << "TcpConnection::handleWrite";
        }
    }else{
        LOG_TRACE << "Connection fd = " << channel_->fd()
                << " is down, no more writing";
    }
}
```

**关闭连接：**

主动关闭：

1. 主动调用TcpConnection::forceClose。

2. 将连接状态设置成kDisconnecting 

3. 异步回调TcpConnection::forceCloseInLoop()

    1. 调用handleClose()

        1. 将连接状态设置成kDisconnected

        2. 取消channel_所有事件

        3. 调用connectionCallback_

        4. 调用closeCallback_（即将TcpServer上的连接信息删除掉）

        5. 异步回调TcpConnection::connectDestroyed

            - 将channel从Poller中移除。

相关代码如下：

```cpp
void TcpConnection::forceClose(){
    // FIXME: use compare and swap
    if (state_ == kConnected || state_ == kDisconnecting){
        setState(kDisconnecting);
        loop_->queueInLoop(std::bind(&TcpConnection::forceCloseInLoop, shared_from_this()));
    }
}

void TcpConnection::forceCloseInLoop(){
    loop_->assertInLoopThread();
    if (state_ == kConnected || state_ == kDisconnecting){
        // as if we received 0 byte in handleRead();
        handleClose();
    }
}

void TcpConnection::handleClose(){
    loop_->assertInLoopThread();
    LOG_TRACE << "fd = " << channel_->fd() << " state = " << stateToString();
    assert(state_ == kConnected || state_ == kDisconnecting);
    // we don't close fd, leave it to dtor, so we can find leaks easily.
    setState(kDisconnected);
    channel_->disableAll();

    TcpConnectionPtr guardThis(shared_from_this());
    connectionCallback_(guardThis);   // connectionCallback_见TcpServer
    // must be the last line
    closeCallback_(guardThis);    // closeCallback_见TcpServer
}

void TcpConnection::connectDestroyed(){
    loop_->assertInLoopThread();
    if (state_ == kConnected){
        setState(kDisconnected);
        channel_->disableAll();

        connectionCallback_(shared_from_this());
    }
    channel_->remove();
}
```

被动关闭：

- TcpConnection::handleRead：因为read返回0，代表连接已经被关闭。会被动调用handleClose。

- Channel::handleEventWithGuard：channel_触发POLLHUP事件，连接被关闭，会被动调用handleClose。

## 细节明细

**疑问：**

为什么 muduo 要设计一个 shutdown() 半关闭TCP连接？

**解答：**

用 shutdown 而不用 close 的效果是，如果对方已经发送了数据，这些数据还“在路上”，那么 muduo 不会漏收这些数据。换句话说，muduo 在 TCP 这一层面解决了“当你打算关闭网络连接的时候，如何得知对方有没有发了一些数据而你还没有收到？”这一问题。当然，这个问题也可以在上面的协议层解决，双方商量好不再互发数据，就可以直接断开连接。

完整的流程是：我们发完了数据，于是 shutdownWrite，发送 TCP FIN 分节，对方会读到 0 字节，然后对方通常会关闭连接，这样 muduo 会读到 0 字节，然后 muduo 关闭连接。

原文链接：https://blog.csdn.net/Solstice/article/details/6208634

## 小结

本章涉及的回调有些复杂，有遗漏的，后面会补充。至此，Muduo服务端源码分析，基本完成。真心建议各位读者能反复去阅读Muduo的源码。

后续可能会计划出一下sylar的源码笔记。然后看有没有时间整理一下LevelDB的源码笔记（可能会鸽，因为马上要春招了，并没有多少时间去写博客）但找到工作之后，也会坚持写的。而且存储方面我也就了解点LevelDB，没有其他存储引擎的底子，没有对比理解的可能也不是很深。

---

**本章完结**