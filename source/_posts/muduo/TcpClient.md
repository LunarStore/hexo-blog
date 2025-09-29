---
title: muduo源码阅读笔记（11、TcpClient）
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

[muduo源码阅读笔记（11、TcpClient）](./TcpClient.md)

**前言**

本章新涉及的文件有：

1. TcpClient.h/cc：和TcpServer不同的是，TcpClient位于客户端，主要是对客户发起的连接进行管理，TcpClient只有一个loop，也会和TcpConnection配合，将三次握手连接成功的sockfd交由TcpConnection管理。

2. Connector.h/cc：Muduo将一个客户端的sock分成了两个阶段，分别是：连接阶段、读写阶段，Connector就是负责fd的连接阶段，当一个sockfd连接成功后，将sockfd传给TcpClient，由TcpClient将sockfd传给TcpConnection进行读写管理，Connector和TcpServer的Acceptor在设计上有这类似的思想，不同的是，Connector是可以针对同一个ip地址进行多次连接，产生不同的sockfd、而Acceptor是去读listen sock来接收连接，产生不同sockfd。

总体来说，TcpClient的实现是**严格遵循**TcpServer的实现的，

## Connector的实现

**提供的接口：**

<!-- more -->
```cpp
class Connector : noncopyable,
                  public std::enable_shared_from_this<Connector>{
public:
    typedef std::function<void (int sockfd)> NewConnectionCallback;

    Connector(EventLoop* loop, const InetAddress& serverAddr);
    ~Connector();

    void setNewConnectionCallback(const NewConnectionCallback& cb)
    { newConnectionCallback_ = cb; }

    void start();  // can be called in any thread
    void restart();  // must be called in loop thread
    void stop();  // can be called in any thread

    const InetAddress& serverAddress() const { return serverAddr_; }

    private:
    enum States { kDisconnected, kConnecting, kConnected };
    static const int kMaxRetryDelayMs = 30*1000;
    static const int kInitRetryDelayMs = 500;

    void setState(States s) { state_ = s; }
    void startInLoop();
    void stopInLoop();
    void connect();
    void connecting(int sockfd);
    void handleWrite();
    void handleError();
    void retry(int sockfd);
    int removeAndResetChannel();
    void resetChannel();

    EventLoop* loop_; // 连接发起所在loop
    InetAddress serverAddr_;  // 连接到哪里
    bool connect_; // atomic  // 开始连接？
    States state_;  // FIXME: use atomic variable // 连接状态
    std::unique_ptr<Channel> channel_;  // fd读写以及读写事件管理，对epoll/poll/selectIO多路复用的抽象，方便跨平台。
    NewConnectionCallback newConnectionCallback_; // 一般是：TcpClient::newConnection
    int retryDelayMs_;  // 连接重试毫秒数。
};
```

简单记录一下连接阶段启动流程：

调用Connector::start()->

1. connect_ 赋值为 true。

2. 在loop任务队列追加Connector::startInLoop()回调任务

    1. 执行回调任务：Connector::startInLoop()

    2. 调用Connector::connect()

        1. 创建非阻塞的连接sock
        
        2. ::connect(sock, ...)
        
        3. 调用Connector::connecting(int sockfd)

            1. new channel(sockfd)赋值给channel_将Connector::handleWrite()和Connector::handleError()设置给cahnnel的写回调以及错误处理回调

            2. 使能Poller开始监听sockfd

当连接成功，会触发sockfd的写事件，从而调用Connector::handleWrite()->

1. 将sockfd和channel_解绑，并将channel_ rest。

2. 调用newConnectionCallback_（也即TcpClient::newConnection）将连接完成的sockfd传给TcpClient处理

感兴趣的读者，可以自行阅读源码，了解连接过程中，stop、retry的流程。

**实现的伪代码：**

```cpp

void Connector::start(){
    connect_ = true;
    loop_->runInLoop(std::bind(&Connector::startInLoop, this)); // FIXME: unsafe
}

void Connector::startInLoop(){
    loop_->assertInLoopThread();
    assert(state_ == kDisconnected);
    if (connect_){
        connect();
    }else{
        LOG_DEBUG << "do not connect";
    }
}

void Connector::stop(){
    connect_ = false;
    loop_->queueInLoop(std::bind(&Connector::stopInLoop, this)); // FIXME: unsafe
    // FIXME: cancel timer
}

void Connector::stopInLoop(){
    loop_->assertInLoopThread();
    if (state_ == kConnecting){
        setState(kDisconnected);
        int sockfd = removeAndResetChannel();
        retry(sockfd);
    }
}

void Connector::connect(){
    int sockfd = sockets::createNonblockingOrDie(serverAddr_.family());
    int ret = sockets::connect(sockfd, serverAddr_.getSockAddr());
    int savedErrno = (ret == 0) ? 0 : errno;
    switch (savedErrno){
        case 0:
        case EINPROGRESS:
        case EINTR:
        case EISCONN:
            connecting(sockfd);
            break;
        /*...*/
    }
}

void Connector::connecting(int sockfd){
    setState(kConnecting);
    assert(!channel_);
    channel_.reset(new Channel(loop_, sockfd));
    channel_->setWriteCallback(
        std::bind(&Connector::handleWrite, this)); // FIXME: unsafe
    channel_->setErrorCallback(
        std::bind(&Connector::handleError, this)); // FIXME: unsafe

    // channel_->tie(shared_from_this()); is not working,
    // as channel_ is not managed by shared_ptr
    channel_->enableWriting();
}

int Connector::removeAndResetChannel(){
    channel_->disableAll();
    channel_->remove();
    int sockfd = channel_->fd();
    // Can't reset channel_ here, because we are inside Channel::handleEvent
    loop_->queueInLoop(std::bind(&Connector::resetChannel, this)); // FIXME: unsafe
    return sockfd;
}

void Connector::resetChannel(){
    channel_.reset();
}

void Connector::handleWrite(){
    LOG_TRACE << "Connector::handleWrite " << state_;

    if (state_ == kConnecting){
        int sockfd = removeAndResetChannel();
        int err = sockets::getSocketError(sockfd);

        if (err){
            LOG_WARN << "Connector::handleWrite - SO_ERROR = "
                    << err << " " << strerror_tl(err);
            retry(sockfd);
        }else{
            setState(kConnected);
            if (connect_){
                newConnectionCallback_(sockfd);
            }else{
                sockets::close(sockfd);
            }
        }
    }else{
        // what happened?
        assert(state_ == kDisconnected);
    }
}

void Connector::handleError(){
    LOG_ERROR << "Connector::handleError state=" << state_;
    if (state_ == kConnecting){
        int sockfd = removeAndResetChannel();
        int err = sockets::getSocketError(sockfd);
        LOG_TRACE << "SO_ERROR = " << err << " " << strerror_tl(err);
        retry(sockfd);
    }
}

void Connector::retry(int sockfd){
    sockets::close(sockfd);
    setState(kDisconnected);
    if (connect_){
        LOG_INFO << "Connector::retry - Retry connecting to " << serverAddr_.toIpPort()
                    << " in " << retryDelayMs_ << " milliseconds. ";
        loop_->runAfter(retryDelayMs_/1000.0, // 稍后重试
                        std::bind(&Connector::startInLoop, shared_from_this()));
        retryDelayMs_ = std::min(retryDelayMs_ * 2, kMaxRetryDelayMs);  // 超时加倍
    }else{
        LOG_DEBUG << "do not connect";
    }
}
```

## TcpClient的实现

**提供的接口：**

```cpp
class TcpClient : noncopyable
{
public:
    // TcpClient(EventLoop* loop);
    // TcpClient(EventLoop* loop, const string& host, uint16_t port);
    TcpClient(EventLoop* loop,
            const InetAddress& serverAddr,
            const string& nameArg);
    ~TcpClient();  // force out-line dtor, for std::unique_ptr members.

    void connect();
    void disconnect();
    void stop();

    TcpConnectionPtr connection() const
    {
    MutexLockGuard lock(mutex_);
    return connection_;
    }

    EventLoop* getLoop() const { return loop_; }
    bool retry() const { return retry_; }
    void enableRetry() { retry_ = true; }

    const string& name() const
    { return name_; }

    /// Set connection callback.
    /// Not thread safe.
    void setConnectionCallback(ConnectionCallback cb)
    { connectionCallback_ = std::move(cb); }

    /// Set message callback.
    /// Not thread safe.
    void setMessageCallback(MessageCallback cb)
    { messageCallback_ = std::move(cb); }

    /// Set write complete callback.
    /// Not thread safe.
    void setWriteCompleteCallback(WriteCompleteCallback cb)
    { writeCompleteCallback_ = std::move(cb); }

private:
    /// Not thread safe, but in loop
    void newConnection(int sockfd);
    /// Not thread safe, but in loop
    void removeConnection(const TcpConnectionPtr& conn);

    EventLoop* loop_; // 运行在那个loop
    ConnectorPtr connector_; // avoid revealing Connector // 连接器
    const string name_; // TcpClient名
    ConnectionCallback connectionCallback_;   // 连接建立和断开回调
    MessageCallback messageCallback_;   // 可读回调
    WriteCompleteCallback writeCompleteCallback_;   // 写完回调
    bool retry_;   // atomic  重连
    bool connect_; // atomic  // 已经连接？
    // always in loop thread
    int nextConnId_;  // 字面意思
    mutable MutexLock mutex_;
    TcpConnectionPtr connection_ GUARDED_BY(mutex_);  // 连接读写管理器
};
```

TcpClient核心函数TcpClient::newConnection，该函数会作为连接器的回调，当sockfd连接成功后，该函数被调用，设置必要信息后，为该sockfd产生一个TcpConnection对象，后续该fd的读写，全权交由TcpConnection处理。逻辑比较简单，实现如下：

**实现的伪代码：**

```cpp
TcpClient::TcpClient(EventLoop* loop,
                     const InetAddress& serverAddr,
                     const string& nameArg)
  : loop_(CHECK_NOTNULL(loop)),
    connector_(new Connector(loop, serverAddr)),
    name_(nameArg),
    connectionCallback_(defaultConnectionCallback),
    messageCallback_(defaultMessageCallback),
    retry_(false),
    connect_(true),
    nextConnId_(1){
    
    connector_->setNewConnectionCallback(
        std::bind(&TcpClient::newConnection, this, _1));
    // FIXME setConnectFailedCallback
    LOG_INFO << "TcpClient::TcpClient[" << name_
            << "] - connector " << get_pointer(connector_);
}

void TcpClient::connect(){
    // FIXME: check state
    LOG_INFO << "TcpClient::connect[" << name_ << "] - connecting to "
            << connector_->serverAddress().toIpPort();
    connect_ = true;
    connector_->start();
}

void TcpClient::disconnect(){
    connect_ = false;

    {
        MutexLockGuard lock(mutex_);
        if (connection_){
            connection_->shutdown();
        }
    }
}

void TcpClient::stop(){
    connect_ = false;
    connector_->stop();
}

void TcpClient::newConnection(int sockfd){
    loop_->assertInLoopThread();
    InetAddress peerAddr(sockets::getPeerAddr(sockfd));
    char buf[32];
    snprintf(buf, sizeof buf, ":%s#%d", peerAddr.toIpPort().c_str(), nextConnId_);
    ++nextConnId_;
    string connName = name_ + buf;

    InetAddress localAddr(sockets::getLocalAddr(sockfd));
    // FIXME poll with zero timeout to double confirm the new connection
    // FIXME use make_shared if necessary
    TcpConnectionPtr conn(new TcpConnection(loop_,
                                            connName,
                                            sockfd,
                                            localAddr,
                                            peerAddr));

    conn->setConnectionCallback(connectionCallback_);
    conn->setMessageCallback(messageCallback_);
    conn->setWriteCompleteCallback(writeCompleteCallback_);
    conn->setCloseCallback(
        std::bind(&TcpClient::removeConnection, this, _1)); // FIXME: unsafe
    {
        MutexLockGuard lock(mutex_);
        connection_ = conn;
    }
    conn->connectEstablished(); // 同一loop，可以直接调用
}

void TcpClient::removeConnection(const TcpConnectionPtr& conn){
    loop_->assertInLoopThread();
    assert(loop_ == conn->getLoop());

    {
        MutexLockGuard lock(mutex_);
        assert(connection_ == conn);
        connection_.reset();
    }

    loop_->queueInLoop(std::bind(&TcpConnection::connectDestroyed, conn));
    if (retry_ && connect_){
    LOG_INFO << "TcpClient::connect[" << name_ << "] - Reconnecting to "
                << connector_->serverAddress().toIpPort();
    connector_->restart();
    }
}
```

### 细节明细：

**疑问**

在TcpConnection::handleClose()实现当中，为什么没有调用close，关闭sockfd？也看了一下TcpConnection的析构、TcpConnection::connectDestroyed()，没有一个地方调用了close来关闭sockfd

**解答**

在 TcpConnection 对象析构的时候。TcpConnection 持有一个 Socket 对象，Socket 是一个 RAII handler，它的析构函数会 close(sockfd_)。这样，如果发生 TcpConnection 对象泄漏，那么我们从 /proc/pid/fd/ 就能找到没有关闭的文件描述符，便于查错。

原文链接：https://blog.csdn.net/Solstice/article/details/6208634

## 总结

Muduo设计的TcpServer和TcpClient代码思想及其统一，一些算法题也是需要这样的抽象思维，所以我认为这也是以后从事it最重要的品质，可以避免很多不必要的bug。