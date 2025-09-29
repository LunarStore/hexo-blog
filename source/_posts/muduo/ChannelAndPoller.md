---
title: muduo源码阅读笔记（5、Channel和Poller）
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

简单讲，Channel就是对文件描述符（fd）的封装，进行事件管理，将fd和对其操作的回调封装在一起，方便，在fd上有IO事件到来时，利用相应的回调来处理IO事件；Poller就是对Linux下各种IO多路复用进行抽象，提供一个统一的接口，该类是一个虚基类。路径./net/poller中的源码，就是对Poller的实现，包括：EPollPoller、PollPoller。

这部分源代码很朴实易懂，代码量也不大，建议读者，亲自看看源码。

## Channel的实现

**提供的接口：**

<!-- more -->
```cpp
class Channel : noncopyable{
public:
    typedef std::function<void()> EventCallback;
    typedef std::function<void(Timestamp)> ReadEventCallback;

    Channel(EventLoop* loop, int fd);
    ~Channel();

    void handleEvent(Timestamp receiveTime);
    void setReadCallback(ReadEventCallback cb)
    { readCallback_ = std::move(cb); }
    void setWriteCallback(EventCallback cb)
    { writeCallback_ = std::move(cb); }
    void setCloseCallback(EventCallback cb)
    { closeCallback_ = std::move(cb); }
    void setErrorCallback(EventCallback cb)
    { errorCallback_ = std::move(cb); }

    /// Tie this channel to the owner object managed by shared_ptr,
    /// prevent the owner object being destroyed in handleEvent.
    void tie(const std::shared_ptr<void>&);

    int fd() const { return fd_; }
    int events() const { return events_; }
    void set_revents(int revt) { revents_ = revt; } // used by pollers
    // int revents() const { return revents_; }
    bool isNoneEvent() const { return events_ == kNoneEvent; }

    void enableReading() { events_ |= kReadEvent; update(); }
    void disableReading() { events_ &= ~kReadEvent; update(); }
    void enableWriting() { events_ |= kWriteEvent; update(); }
    void disableWriting() { events_ &= ~kWriteEvent; update(); }
    void disableAll() { events_ = kNoneEvent; update(); }
    bool isWriting() const { return events_ & kWriteEvent; }
    bool isReading() const { return events_ & kReadEvent; }

    // for Poller
    int index() { return index_; }
    void set_index(int idx) { index_ = idx; }

    // for debug
    string reventsToString() const;
    string eventsToString() const;

    void doNotLogHup() { logHup_ = false; }

    EventLoop* ownerLoop() { return loop_; }
    void remove();

private:
    static string eventsToString(int fd, int ev);

    void update();
    void handleEventWithGuard(Timestamp receiveTime);

    static const int kNoneEvent;  // 0
    static const int kReadEvent;  // POLLIN | POLLPRI
    static const int kWriteEvent; // POLLOUT

    EventLoop* loop_; // channel被那个EventLoop监听
    const int  fd_; // fd
    int        events_;
    int        revents_; // it's the received event types of epoll or poll // 触发的事件
    int        index_; // used by Poller.
    bool       logHup_;

    std::weak_ptr<void> tie_;   // 主要解决循环引用的问题
    bool tied_;
    bool eventHandling_;  // 正在handleEventWithGuard中处理事件
    bool addedToLoop_;  // 被添加到EventLoop了没？
    ReadEventCallback readCallback_;  // 读回调
    EventCallback writeCallback_; // 写回调
    EventCallback closeCallback_; // 连接断开回调
    EventCallback errorCallback_; // 错误处理回调
};
```

**实现的伪代码：**

```cpp
Channel::Channel(EventLoop* loop, int fd__)
  : loop_(loop),
    fd_(fd__),
    events_(0),
    revents_(0),
    index_(-1),
    logHup_(true),
    tied_(false),
    eventHandling_(false),
    addedToLoop_(false)
{
}

Channel::~Channel(){
    assert(!eventHandling_);
    assert(!addedToLoop_);
    if (loop_->isInLoopThread()){
        // 该channel即将销毁，不能被EventLoop监听
        assert(!loop_->hasChannel(this));
    }
}

void Channel::tie(const std::shared_ptr<void>& obj){
    tie_ = obj;   // 循环依赖，做生命周期的绑定
    tied_ = true;
}

void Channel::update(){
    // 在EventLoop中进行fd的事件更新
    addedToLoop_ = true;
    loop_->updateChannel(this);
}

void Channel::remove(){
    // 取消EventLoop对channel的监听
    assert(isNoneEvent());
    addedToLoop_ = false;
    loop_->removeChannel(this);
}

void Channel::handleEvent(Timestamp receiveTime){
    std::shared_ptr<void> guard;
    if (tied_){
        guard = tie_.lock();
        if (guard){ // 保证依赖对象没有被释放
            handleEventWithGuard(receiveTime);
        }
    }else{
        handleEventWithGuard(receiveTime);
    }
}

void Channel::handleEventWithGuard(Timestamp receiveTime){
    eventHandling_ = true;
    if ((revents_ & POLLHUP) && !(revents_ & POLLIN)){
        // 连接断开，并且fd上没有可读数据（默认水平触发）
        // 调用关闭回调
        if (closeCallback_) closeCallback_();
    }

    if (revents_ & (POLLERR | POLLNVAL)){
        // 错误处理
        if (errorCallback_) errorCallback_();
    }
    if (revents_ & (POLLIN | POLLPRI | POLLRDHUP)){
        // 可读
        if (readCallback_) readCallback_(receiveTime);
    }
    if (revents_ & POLLOUT){
        // 可写
        if (writeCallback_) writeCallback_();
    }
    eventHandling_ = false;
}

```

**注意**

**智能指针不是万能的，并不能解决cpp所有内存泄露的问题！！！**

这里多提一句，关于循环引用这种头疼的问题，几个类可能很容易看出来，但是如果项目太大，涉及的类太多，就很容出现循环引用导致内存泄漏的问题！而且难以察觉。所以，在类的设计上，要特别注意这个坑。

自引用：

```cpp
class Node;

class Node {
public:
    std::shared_ptr<Node> next;

    Node() {
        std::cout << "Node constructed" << std::endl;
    }

    ~Node() {
        std::cout << "Node destructed" << std::endl;
    }
};

int main() {
    std::shared_ptr<Node> node1 = std::make_shared<Node>();

    node1->next = node1;
    return 0;
}

```

结果如下：

```
[root@localhost muduo]# g++ -Wall -std=c++11 -o test.bin test.cc 
[root@localhost muduo]# 
[root@localhost muduo]# 
[root@localhost muduo]# ./test.bin 
Node constructed
[root@localhost muduo]#
```

**多个类间的循环引用是同理的，一般是靠weak_ptr解决，单个类的自引用的化话，目前无解。**

### 细节明细：

**疑问：**

Muduo中Channel的成员变量`std::weak_ptr<void> tie_`有什么意义？

**解答：**

使用std::weak_ptr的目的是为了避免循环引用（circular reference），因为TcpConnection对象通常也会持有一个指向Channel的指针。通过使用std::weak_ptr，可以避免引发循环引用导致对象无法正确释放的问题。

**疑问：**

fd上何时返回POLLHUP又何时返回POLLRDHUP？（POLLIN/POLLOUT呢？）

**解答：**

有写过一个deamo（有时间再写这方面的博客）专门测试这些事件触发条件，实验表明，POLLHUP事件一般是系统默认添加的事件，在连接关闭时会触发，而POLLIN/POLLOUT/POLLRDHUP等，需要用户手动添加才会触发。

|   事件        |   水平触发                                                            |   边沿触发                    |
|   :---:         |   :---:                                                             |   :---:                       |
|   POLLIN      |   接收缓存有数据就一直触发                                                |   接收缓存有新数据来就触发    |
|   POLLOUT     |   发送缓存未满就一致触发                                                  |   发送数据就触发              |
|   POLLRDHUP   |   对端写关闭，本端就触发，同时触发POLLIN                                  |   同水平                      |
|   POLLHUP     |   连接关闭，同时触发POLLIN/POLLOUT事件（用户添加过什么事件就触发什么事件）    |   同水平                      |

## Poller的实现

简单提一下，在Muduo中，Poller是对原生的linux下，C语言的IO多路复用接口进行了封装，毕竟面向对象用起来更舒服。Poller会在EventLoop中使用。具体，怎么使用，在下一章节，讲到EventLoop时，才会有所领悟，这里可以所见即所得，知道Poller就是封装IO多路复用的即可。

**Poller提供的接口：**

```cpp
class Poller : noncopyable{
public:
    typedef std::vector<Channel*> ChannelList;

    Poller(EventLoop* loop);
    virtual ~Poller();

    /// Polls the I/O events.
    /// Must be called in the loop thread.
    virtual Timestamp poll(int timeoutMs, ChannelList* activeChannels) = 0;

    /// Changes the interested I/O events.
    /// Must be called in the loop thread.
    virtual void updateChannel(Channel* channel) = 0;

    /// Remove the channel, when it destructs.
    /// Must be called in the loop thread.
    virtual void removeChannel(Channel* channel) = 0;

    virtual bool hasChannel(Channel* channel) const;

    static Poller* newDefaultPoller(EventLoop* loop);

    void assertInLoopThread() const{
        ownerLoop_->assertInLoopThread();
    }

protected:
    typedef std::map<int, Channel*> ChannelMap; 
    ChannelMap channels_;// fd到channel的映射

    private:
    EventLoop* ownerLoop_;  // 所属的EventLoop
};
```

**Poller实现的伪代码：**

```cpp
Poller::Poller(EventLoop* loop)
  : ownerLoop_(loop){
}

Poller::~Poller() = default;

bool Poller::hasChannel(Channel* channel) const{
    assertInLoopThread();
    ChannelMap::const_iterator it = channels_.find(channel->fd());
    return it != channels_.end() && it->second == channel;
}

```

因为Muduo继承Poller实现了EPollPoller、PollPoller，考虑到篇幅有限，这里讲一下PollPoller的实现吧。

### PollPoller的实现

在muduo网络库中，PollPoller 是对 poll() 系统调用的封装，用于实现事件循环（EventLoop）中的事件分发。PollPoller 负责将 Channel管理的文件描述符注册到 poll() 中，监听各个文件描述符的事件。

以下是对 PollPoller 的简要介绍：

1. 文件位置： PollPoller 类的实现通常位于 PollPoller.cc 文件中。

2. 继承关系： PollPoller 类继承自 Poller 类，而 Poller 类是对事件轮询机制的抽象。

3. 主要方法： 重要的方法包括 poll 和 fillActiveChannels。

    - poll 方法负责调用 poll() 系统调用，等待事件发生。
    - fillActiveChannels 方法用于将 poll() 返回的就绪事件填充到 activeChannels 中。

4. 事件分发： PollPoller 通过 EventLoop 实现了事件的分发。当有事件发生时，PollPoller 会通知 EventLoop，而后 EventLoop 会调用相应的 Channel 的handleEvent进行事件处理。

**提供的接口**

```cpp
class PollPoller : public Poller{
public:

    PollPoller(EventLoop* loop);
    ~PollPoller() override;

    Timestamp poll(int timeoutMs, ChannelList* activeChannels) override;
    void updateChannel(Channel* channel) override;
    void removeChannel(Channel* channel) override;

private:
    void fillActiveChannels(int numEvents,
                            ChannelList* activeChannels) const;

    /*
    * struct pollfd定义如下：
    *    struct pollfd {
    *        int   fd;     // 监听的文件描述符    
    *       short events;   // 要监听的事件
    *        short revents; // 监听到得到事件
    *    };
    */

    typedef std::vector<struct pollfd> PollFdList;
    PollFdList pollfds_;
};

```

**实现的伪代码**

```cpp
PollPoller::PollPoller(EventLoop* loop)
  : Poller(loop){
}

PollPoller::~PollPoller() = default;

// 提供给EventLoop的接口，也是EventLoop 等待事件的程序点。
Timestamp PollPoller::poll(int timeoutMs, ChannelList* activeChannels){
    // 等待事件到来，或者超时
    // XXX pollfds_ shouldn't change
    int numEvents = ::poll(&*pollfds_.begin(), pollfds_.size(), timeoutMs);
    int savedErrno = errno;
    Timestamp now(Timestamp::now());
    if (numEvents > 0){
        fillActiveChannels(numEvents, activeChannels);
    }else if (numEvents == 0){
        LOG_TRACE << " nothing happened";
    }else{
        if (savedErrno != EINTR){   // 中断
            errno = savedErrno;
            LOG_SYSERR << "PollPoller::poll()";
        }
    }
    return now;
}

void PollPoller::fillActiveChannels(int numEvents,
                                    ChannelList* activeChannels) const{
    // 将所有发生事件的fd对应的channel，收集到activeChannels，供EventLoop处理
    for (PollFdList::const_iterator pfd = pollfds_.begin();
        pfd != pollfds_.end() && numEvents > 0; ++pfd){
        if (pfd->revents > 0){
            --numEvents;
            ChannelMap::const_iterator ch = channels_.find(pfd->fd);
            assert(ch != channels_.end());   //一定要存在
            Channel* channel = ch->second;
            channel->set_revents(pfd->revents);
            // pfd->revents = 0;    // poll会自动清零
            activeChannels->push_back(channel);
        }
    }
}

void PollPoller::updateChannel(Channel* channel){
    Poller::assertInLoopThread();
    if (channel->index() < 0){
        // 新的channel
        // a new one, add to pollfds_
        assert(channels_.find(channel->fd()) == channels_.end());
        struct pollfd pfd;
        pfd.fd = channel->fd();
        pfd.events = static_cast<short>(channel->events());
        pfd.revents = 0;
        pollfds_.push_back(pfd);
        int idx = static_cast<int>(pollfds_.size())-1;
        channel->set_index(idx);
        channels_[pfd.fd] = channel;
    }else{
        // update existing one
        assert(channels_.find(channel->fd()) != channels_.end());
        int idx = channel->index();
        // idx 有效
        assert(0 <= idx && idx < static_cast<int>(pollfds_.size()));
        struct pollfd& pfd = pollfds_[idx];
        // fd对的上，或者，因为之前不需要监听，被置为-(fd + 1)保证为负，这样，poll不会监听fd为负的channel。
        assert(pfd.fd == channel->fd() || pfd.fd == -channel->fd()-1);
        pfd.fd = channel->fd();
        pfd.events = static_cast<short>(channel->events());
        pfd.revents = 0;
        if (channel->isNoneEvent()){
            // 事件为空，置为负。
            // ignore this pollfd
            pfd.fd = -channel->fd()-1;
        }
    }
}

void PollPoller::removeChannel(Channel* channel){
    Poller::assertInLoopThread();
    assert(channels_.find(channel->fd()) != channels_.end());
    assert(channels_[channel->fd()] == channel);
    assert(channel->isNoneEvent());
    int idx = channel->index();
    assert(0 <= idx && idx < static_cast<int>(pollfds_.size()));
    const struct pollfd& pfd = pollfds_[idx]; (void)pfd;
    assert(pfd.fd == -channel->fd()-1 && pfd.events == channel->events());
    size_t n = channels_.erase(channel->fd());
    assert(n == 1); (void)n;

    /*
    * 因为poll是基于数组做轮询，考虑到数组的删除代价很大，所以Muduo在这里
    * 做了一个优化：如果删除的fd正好是数组尾部，直接pop_back即可，否则，
    * 把要删除的fd和数组最后一个元素做交换，并通过父类的channels_设置原来
    * 最后一个fd对应的cahnnel的index。最后，删除数组最后一个需要删除的fd即
    * 可。
    */
    if (implicit_cast<size_t>(idx) == pollfds_.size()-1){
        pollfds_.pop_back();
    }else{
        int channelAtEnd = pollfds_.back().fd;
        iter_swap(pollfds_.begin()+idx, pollfds_.end()-1);
        if (channelAtEnd < 0){
            channelAtEnd = -channelAtEnd-1;
        }
        channels_[channelAtEnd]->set_index(idx);
        pollfds_.pop_back();
    }
}
```

## 细节明细

**疑问**

Muduo为什么要额外为fd的事件封装一个Channel?

**解答**

Channel和Poller的封装其实有考量Muduo的跨平台，为fd的事件多抽象一层channel，在使用不同平台的IO多路复用接口时，只需编写不同平台的Poller代码，然后触发事件后，统一将事件交由channel由上层统一处理，达到了解耦合的效果。Redis网络部分也做了类似的处理。

---

**本章完结**