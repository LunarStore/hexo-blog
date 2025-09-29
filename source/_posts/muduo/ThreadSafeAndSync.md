---
title: muduo源码阅读笔记（2、对C语言原生的线程安全以及同步的API的封装）
date: 2024-01-11 12:00:00
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

**闲聊**

首先感慨一句，muduo库对C语言原生的线程安全以及同步的API的封装，真的称得上是教科书式的，非常精妙、规范，很值得学习。

读者在阅读muduo源码的时候，看到类定义的类名称被一些宏定义修饰、以及类的成员变量被一些宏定义修饰时，可以直接忽略，无视这些宏。因为这些东西的存在完全不影响整体的功能。简单来说就是吓唬人的。不仅如此，在看muduo以及其他的源码的时候，我们没必要转牛角尖，死扣细节，对于一个类，如果我们可以猜到他的功能以及怎么实现的，我们可以直接看他在源码中的使用即可，没必要在这细节上面浪费精力，专注整体架构，以及思想，不太过专注细节，才是阅读一份源码的正确套路。
## 原子操作

提到原子操作，不得不顺便提一下c++ std::atomic的原子操作以及它的内存序，这个知识点，以后的博客再来记录。

这里是muduo对gcc提供的原子操作api的封装：

<!-- more -->
```cpp
template<typename T>
class AtomicIntegerT : noncopyable
{
public:
    AtomicIntegerT()
    : value_(0)
    {
    }
    T get()
    {
        return __sync_val_compare_and_swap(&value_, 0, 0);
    }

    T getAndAdd(T x)
    {
        return __sync_fetch_and_add(&value_, x);
    }

    T addAndGet(T x)
    {
        return getAndAdd(x) + x;
    }

    T incrementAndGet()
    {
        return addAndGet(1);
    }

    T decrementAndGet()
    {
        return addAndGet(-1);
    }

    void add(T x)
    {
        getAndAdd(x);
    }

    void increment()
    {
        incrementAndGet();
    }

    void decrement()
    {
        decrementAndGet();
    }

    T getAndSet(T newValue)
    {
        return __sync_lock_test_and_set(&value_, newValue);
    }

private:
    volatile T value_;
};
```

1. 函数原型：`type __sync_val_compare_and_swap(type *ptr, type oldval, type newval, ...)`

    **参数：**

    - type：被操作的数据类型，可以是整数类型、指针等。
    - ptr：要进行 CAS 操作的地址，通常是一个指针。
    - oldval：期望的旧值。
    - newval：新值。

    **描述：**

    该函数的作用是，如果 \*ptr 的当前值等于 oldval，则将 \*ptr 的值设置为 newval，并**返回 \*ptr 之前的值**。如果 \*ptr 的当前值不等于 oldval，则不进行任何操作，直接**返回 \*ptr 的当前值**。

    这样的操作是原子的，即在多线程环境下，不会被其他线程中断，确保了操作的一致性。CAS 操作通常用于实现锁、同步原语和非阻塞算法等。

2. 函数原型：`type __sync_fetch_and_add(type *ptr, type value, ...)`

    **参数：**

    - type：被操作的数据类型，可以是整数类型、指针等。
    - ptr：要进行自增操作的地址，通常是一个指针。
    - value：要添加到 \*ptr 的值。

    **描述：**

    该函数的作用是，将 \*ptr 的值与 value 相加，**并返回 \*ptr 之前的值**。这个操作是原子的，确保在多线程环境下不会被其他线程中断，从而保证了操作的一致性。自增操作通常用于实现计数器等场景。

3. 函数原型：`type __sync_lock_test_and_set(type *ptr, type value, ...)`

    **参数：**

    - type：被操作的数据类型，可以是整数类型、指针等。
    - ptr：要进行测试并设置的地址，通常是一个指针。
    - value：将要设置到 \*ptr 的值。

    **描述：**

    该函数的作用是，**返回 \*ptr 之前的值**，并将 \*ptr 的值设置为 value。这个操作是原子的，确保在多线程环境下不会被其他线程中断，从而保证了操作的一致性。

## 互斥锁

这里对互斥锁本身的科普就简要概括，主要专注muduo对Posix中的互斥锁的封装思想。

互斥量资源的管理：
```cpp
class CAPABILITY("mutex") MutexLock : noncopyable
{
public:
    MutexLock()
    : holder_(0)
    {
        MCHECK(pthread_mutex_init(&mutex_, NULL));
    }

    ~MutexLock()
    {
        assert(holder_ == 0);
        MCHECK(pthread_mutex_destroy(&mutex_));
    }

    // must be called when locked, i.e. for assertion
    bool isLockedByThisThread() const
    {
        return holder_ == CurrentThread::tid();
    }

    void assertLocked() const ASSERT_CAPABILITY(this)
    {
        assert(isLockedByThisThread());
    }

    // internal usage

    void lock() ACQUIRE()
    {
        MCHECK(pthread_mutex_lock(&mutex_));
        assignHolder();
    }

    void unlock() RELEASE()
    {
        unassignHolder();
        MCHECK(pthread_mutex_unlock(&mutex_));
    }

    pthread_mutex_t* getPthreadMutex() /* non-const */
    {
        return &mutex_;
    }

private:
    friend class Condition;

    /*
    * RAII机制，for条件变量
    * 条件变量中，有详细解释其作用
    */
    class UnassignGuard : noncopyable
    {
    public:
        explicit UnassignGuard(MutexLock& owner)
            : owner_(owner)
        {
            owner_.unassignHolder();
        }

        ~UnassignGuard()
        {
            owner_.assignHolder();
        }

    private:
        MutexLock& owner_;
    };

    void unassignHolder()
    {
        holder_ = 0;
    }

    void assignHolder()
    {
        holder_ = CurrentThread::tid();
    }

    pthread_mutex_t mutex_;
    pid_t holder_;
};
```

互斥锁加锁解锁的管理：

```cpp
/*
* RAII机制
*/
// Use as a stack variable, eg.
// int Foo::size() const
// {
//   MutexLockGuard lock(mutex_);
//   return data_.size();
// }
class SCOPED_CAPABILITY MutexLockGuard : noncopyable
{
public:
    explicit MutexLockGuard(MutexLock& mutex) ACQUIRE(mutex)
    : mutex_(mutex)
    {
        mutex_.lock();
    }

    ~MutexLockGuard() RELEASE()
    {
        mutex_.unlock();
    }

private:

    MutexLock& mutex_;
};
```

互斥锁加锁解锁的管理，使用了C++大名顶顶的RAII机制，

**RAII 的核心思想是：** 在对象的构造函数中获取资源，在析构函数中释放资源。这种方法能够确保资源在对象的生命周期内得到正确的管理，从而避免了手动管理资源的繁琐和容易出错的问题。

**关键点：**

1. **资源的获取和释放与对象的生命周期关联：** 资源（如内存、文件句柄、网络连接等）的获取和释放被绑定到了对象的构造和析构过程中，确保资源在对象生命周期内正确地管理。

2. **构造函数中获取资源：** 在对象的构造函数中，资源被获取。这意味着当对象被创建时，相应的资源就被分配或初始化。

3. **析构函数中释放资源：** 在对象的析构函数中，资源被释放。这确保了在对象生命周期结束时，与之相关的资源会被正确释放。

4. **无需手动管理资源：** 由于资源的获取和释放与对象的生命周期关联，程序员无需手动管理资源。当对象超出作用域或者被删除时，其析构函数会自动被调用，从而释放关联的资源。

**其他RAII应用的例子**

智能指针、文件处理类、数据库连接类等。

## 条件变量

muduo对条件变量本身的封装是没有解决惊群效应的，`pthread_cond_wait`函数没有放在while循环中。但是muduo在其他用到条件变量的地方，其实有利用while循环来解决惊群效应的。比如即将要聊到的`CountDownLatch`类的实现

```cpp
class Condition : noncopyable
{
public:
    explicit Condition(MutexLock& mutex)
    : mutex_(mutex)
    {
        MCHECK(pthread_cond_init(&pcond_, NULL));
    }

    ~Condition()
    {
        MCHECK(pthread_cond_destroy(&pcond_));
    }

    void wait()
    {
        /*
        * 这里是raii机制的具体应用，因为MutexLock类里面有个成员变量holder_存储获取到
        * mutex锁的线程id，每次线程对mutex加锁后就会将自己的tid赋值给holder_，而
        * 在释放mutex锁前，会将holder_清零，以示当前mutex锁被哪个线程持有。而线程在等
        * 待获取条件变量时，内部会原子加/解锁。所以为遵循holder_存在的意义，muduo为Condition
        * 实现了UnassignGuard类，利用raii，在等待条件变量解锁前，在构造函数中，
        * 将holder_清零；在获取到条件变量加锁后，在析构函数中，将holder_赋值为获锁线程
        * 的tid。以此保证holder_严格随着获取mutex锁的线程变化。
        */
        MutexLock::UnassignGuard ug(mutex_);
        MCHECK(pthread_cond_wait(&pcond_, mutex_.getPthreadMutex()));
    }

    // returns true if time out, false otherwise.
    bool waitForSeconds(double seconds);

    void notify()
    {
        MCHECK(pthread_cond_signal(&pcond_));
    }

    void notifyAll()
    {
        MCHECK(pthread_cond_broadcast(&pcond_));
    }

private:
    MutexLock& mutex_;
    pthread_cond_t pcond_;
};
```

**关于条件变量和信号量的使用上的差别，说老实话，就我目前的功力，还没有深刻的感受，这里先mark一下，等哪天领悟到之后，再来聊一聊。**

**补充：**

1. 条件变量可以在条件满足时，一次唤醒所有等待条件的线程，但是信号量则不行，只能post一个信号量（资源），唤醒一个线程。在多个线程等待一个条件的满足时再**继续同时**执行的场景下，适合用条件变量。（好像此时也可以用信号量，无非就是多post几次。只是，信号量不适合该场景，而条件变量更加适合）

## CountDownLatch（倒计数同步类）

**使用场景：**

1. 父线程等待多个子线程启动完毕，再继续执行： 在某些并发场景中，可能需要等待多个子线程都完成某个初始化操作后，父线程才能继续执行。CountDownLatch 可以用来等待这些线程的完成。

2. 多个线程等待一个线程某个操作完毕，再继续执行： 可以使用 CountDownLatch 来协调多个线程的并发操作，确保某个操作在所有线程完成之后再执行。

接口：

```cpp
class CountDownLatch : noncopyable
{
public:

    explicit CountDownLatch(int count);

    void wait();

    void countDown();

    int getCount() const;

private:
    mutable MutexLock mutex_;
    Condition condition_ GUARDED_BY(mutex_);
    int count_ GUARDED_BY(mutex_);
};
```

实现：

```cpp
CountDownLatch::CountDownLatch(int count)
  : mutex_(),
    condition_(mutex_),
    count_(count)
{
}

void CountDownLatch::wait()
{
    MutexLockGuard lock(mutex_);
    while (count_ > 0)
    {   // while中解决了惊群效应
        condition_.wait();
    }
}

void CountDownLatch::countDown()
{
    MutexLockGuard lock(mutex_);
    --count_;
    if (count_ == 0)
    {
        // 减为零后，将所有处于条件等待队列的线程，移到枪锁等待队列。
        condition_.notifyAll();
    }
}

int CountDownLatch::getCount() const
{
    MutexLockGuard lock(mutex_);
    return count_;
}
```

**注意：**
我之前用一个demo专门实验过，实验结果表明，线程A调用`pthread_cond_broadcast`唤醒其他所有调用`pthread_cond_wait`阻塞的线程时，所有线程会处于一个枪锁状态（从条件等待队列，移到枪锁队列），线程B抢到锁处理临界资源再释放锁后，其他处于枪锁队列的线程还是处于枪锁状态，并不需要等待条件信号的到来，抢到锁就能处理临界资源。

---

**本章完结**