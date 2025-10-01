---
title: muduo源码阅读笔记（8、定时器TimerQueue）
date: 2024-01-17 12:00:00
categories: 服务器框架
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

为了方便Poller的管理，Muduo定时器是基于文件描述符实现。

## 实现

**定时器提供的接口：**

<!-- more -->
```cpp
class TimerQueue : noncopyable{
public:
    explicit TimerQueue(EventLoop* loop);
    ~TimerQueue();

    ///
    /// Schedules the callback to be run at given time,
    /// repeats if @c interval > 0.0.
    ///
    /// Must be thread safe. Usually be called from other threads.
    TimerId addTimer(TimerCallback cb,
                    Timestamp when,
                    double interval);

    void cancel(TimerId timerId);

private:

    // FIXME: use unique_ptr<Timer> instead of raw pointers.
    // This requires heterogeneous comparison lookup (N3465) from C++14
    // so that we can find an T* in a set<unique_ptr<T>>.
    typedef std::pair<Timestamp, Timer*> Entry;
    typedef std::set<Entry> TimerList;
    typedef std::pair<Timer*, int64_t> ActiveTimer;
    typedef std::set<ActiveTimer> ActiveTimerSet;

    void addTimerInLoop(Timer* timer);
    void cancelInLoop(TimerId timerId);
    // called when timerfd alarms
    void handleRead();
    // move out all expired timers
    std::vector<Entry> getExpired(Timestamp now);
    void reset(const std::vector<Entry>& expired, Timestamp now);

    bool insert(Timer* timer);

    EventLoop* loop_; // 定时器和哪个EventLoop关联
    const int timerfd_; // timerfd_
    Channel timerfdChannel_;  // 基于timerfd_的Channel
    // Timer list sorted by expiration
    TimerList timers_;  // 基于set的定时器（Timestamp，Timer*）

    // for cancel()
    ActiveTimerSet activeTimers_;
    bool callingExpiredTimers_; /* atomic */
    ActiveTimerSet cancelingTimers_;  // （Timer*，int64_t）
};
```
**构造函数：**

在每个EventLoop创建时，在自己的构造函数中，创建自己的定时器`TimerQueue`，并将EventLoop的this指针作为TimerQueue构造函数的参数。TimerQueue的构造会创建一个timerfd，并且向EventLoop的Poller注册timerfd。这样，Poller正式开开始管理定时器。后面的Acceptor、TcpConnection使用了类似的手法。

实现如下：

```cpp
/*
* @param: EventLoop的this指针
*/
TimerQueue::TimerQueue(EventLoop* loop)
  : loop_(loop),
    timerfd_(createTimerfd()),
    timerfdChannel_(loop, timerfd_),
    timers_(),
    callingExpiredTimers_(false)
{
  timerfdChannel_.setReadCallback(
      std::bind(&TimerQueue::handleRead, this));
  // we are always reading the timerfd, we disarm it with timerfd_settime.
  timerfdChannel_.enableReading();  // 向所在的loop中注册timerfd。
}
```

**关于<号的万能性**

将自定义类存入std::set是要求用户实现自定义对象<号重载的。思考一个问题：只重载<的话，如果用户调用find成员函数时，set如何判断两个对象是否相等呢？

其实std::set内部做两次比较即可判断两个对象是否相等。方法：当a < b == false && b < a == false时，说明此时 a == b。读者可以在这里仔细思考一下。Timestamp正是因为实现了<才可以作为std::set的元素类型。


一个自定义对象重载<号后，不光可以通过<推导出==，还可以推到出>、>=、<=号。[参考博客](https://blog.csdn.net/huangjh2017/article/details/74357003)

参考boost::less_than_comparable<Timestamp>的实现，如下：

```cpp
//已知：
friend bool operator<(const T& x, const T& y)  { /*...*/}

// |
// V

//可以推导：
friend bool operator>(const T& x, const T& y)  { return y < x; }
friend bool operator<=(const T& x, const T& y) { return !static_cast<bool>(y < x); }
friend bool operator>=(const T& x, const T& y) { return !static_cast<bool>(x < y); }
```

**定时器实现的伪代码：**

```cpp
TimerId TimerQueue::addTimer(TimerCallback cb,
                             Timestamp when,
                             double interval){
    Timer* timer = new Timer(std::move(cb), when, interval);
    loop_->runInLoop(
        std::bind(&TimerQueue::addTimerInLoop, this, timer));
    return TimerId(timer, timer->sequence());
}

void TimerQueue::cancel(TimerId timerId){
    loop_->runInLoop(
        std::bind(&TimerQueue::cancelInLoop, this, timerId));
}

void TimerQueue::addTimerInLoop(Timer* timer){
    loop_->assertInLoopThread();
    bool earliestChanged = insert(timer); // timer加入最新超时的定时器被更新。

    if (earliestChanged){ 
        // 更新timerfd_的超时时间
        resetTimerfd(timerfd_, timer->expiration());
    }
}

void TimerQueue::cancelInLoop(TimerId timerId){
    loop_->assertInLoopThread();
    assert(timers_.size() == activeTimers_.size());
    ActiveTimer timer(timerId.timer_, timerId.sequence_);
    ActiveTimerSet::iterator it = activeTimers_.find(timer);
    if (it != activeTimers_.end()){ // 在activeTimers_上
        // 在timers_上删除timerId
        delete it->first; // FIXME: no delete please
        // 在activeTimers_上删除timerId
    }else if (callingExpiredTimers_){   // 如果正在处理超时定时器，那么timerId是有可能从activeTimers_上移除，而在handleRead::expired中
        // 所以先将timerId加入cancelingTimers_列表，防止是循环定时器，又被重新加入到activeTimers_。handleRead会调用reset删除被取消的定时器。
        cancelingTimers_.insert(timer);
    }
    assert(timers_.size() == activeTimers_.size());
}

void TimerQueue::handleRead(){ // timerfd_读事件处理回调
    loop_->assertInLoopThread();
    Timestamp now(Timestamp::now());
    readTimerfd(timerfd_, now); // 清空timerfd_上的数据

    std::vector<Entry> expired = getExpired(now);

    callingExpiredTimers_ = true;
    cancelingTimers_.clear();
    // safe to callback outside critical section
    for (const Entry& it : expired){
        it.second->run();   // 调用过期定时器的回调
    }
    callingExpiredTimers_ = false;

    reset(expired, now);    // 看能不能重新安装过期定时器，不能就delete。
}

std::vector<TimerQueue::Entry> TimerQueue::getExpired(Timestamp now){
    assert(timers_.size() == activeTimers_.size());
    std::vector<Entry> expired;

    // 根据now，在timers_中找过期的定时器，存入expired。
    // ...

    for (const Entry& it : expired){ 
        // 同步activeTimers_ 和 timers_
        // ...
    }

    assert(timers_.size() == activeTimers_.size());
    return expired;
}

void TimerQueue::reset(const std::vector<Entry>& expired, Timestamp now){
    Timestamp nextExpire;

    for (const Entry& it : expired){
        ActiveTimer timer(it.second, it.second->sequence());
        if (it.second->repeat()
            && cancelingTimers_.find(timer) == cancelingTimers_.end()){ // 是循环定时器，并且没有被取消。
            it.second->restart(now);
            insert(it.second);
        }else{
            // FIXME move to a free list
            delete it.second; // FIXME: no delete please
        }
    }

    if (!timers_.empty()){
        nextExpire = timers_.begin()->second->expiration();
    }

    if (nextExpire.valid()){
        resetTimerfd(timerfd_, nextExpire);
    }
}

bool TimerQueue::insert(Timer* timer){
    loop_->assertInLoopThread();
    assert(timers_.size() == activeTimers_.size());
    bool earliestChanged = false;
    Timestamp when = timer->expiration(); // timer超时时间
    TimerList::iterator it = timers_.begin(); // 原来定时器中最早超时的定时器
    if (it == timers_.end() || when < it->first){ 
        // 原本timers_就没有定时器 || 要插入的定时器超时时间 比 原来的timers_中第一个定时器 早。
        // 都代表：插入新定时器后，最早超时时间会发生改变，需要重新设置timeFd。
        earliestChanged = true;
    }
    // 插入timers_
    // std::set::insert

    // 同步到activeTimers_
    // std::set::insert
    return earliestChanged;
}
```

## 细节明细：

**疑问**

定时器模块存在的意义？

**解答**

1. 事件触发机制： 定时器在Muduo中被用作一种事件触发机制。通过设置定时器，用户可以在指定的时间间隔内执行相应的操作，例如执行定时任务、发送心跳包等。这种事件触发机制有助于异步编程中的任务调度和协调。

2. 超时处理： 定时器用于处理超时事件，例如连接超时、读写操作超时等。通过设置合适的定时器，Muduo可以及时检测并处理超时情况，确保网络应用的稳定性和可靠性。

3. 可能还不太全，后面再有所感悟再来更新。。。

---

**本章完结**