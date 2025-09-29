---
title: 有关线程局部变量的随记
date: 2024-09-30 12:00:00
tags:
  - C++
---

最近也是在研究workflow框架的源码，看到里面的线程池也用到了线程局部变量，但是用法和sylar的不同，特此来简单记录一下。

## 场景分析

在实际开发中，存在这样一种需求：需要让每一个线程用拥有自己的“独有”的全局变量，听着视乎有些没有任何逻辑。拿sylar举例子，在封装线程的时候，考虑到每个线程的名字不同，所以需要某种方式，在“全局”上定义一个变量名为：thread_name的变量，但是，此全局仅针对某一个线程。再比如，sylar在编写协程调度器时，**每一个线程都需要记录自己当前正在运行的协程，以及该线程所绑定的调度协程，基于这两个协程才能实现协程任务的调度。** 具体细节读者可以参考[sylar协程调度器的实现](../sylar/Scheduler.md)。这里同样需要在“全局”上定义一个变量，此全局是各个线程所独享的“全局”。这点很重要。

## 实现的可选方案

### C++方式定义线程局部变量

C++定义线程局部变量的方式特别简单，就是在全局声明一个变量的时候，在前面加上thread_local关键字即可。在每个线程被创建初始化时，会各自创建同名，但不同对象的变量。也即：线程内部共享，但是线程之间独享的“全局变量”。

<!-- more -->
```cpp
static thread_local Scheduler* t_scheduler = nullptr;
static thread_local Fiber* t_scheduler_fiber = nullptr;
```

这种用法是C++11补充的特性。thread_local可以定义在结构体内部或者类的内部。这样默认会加上static关键字。

### 使用GCC提供的方式

__thread是GCC的关键字，非Unix编程或C语言标准，属于编译器自己实现。__thread只能修饰基础数据类型或者POD类型。

所谓POD就是C语言中传统的struct类型。即无拷贝、析构函数的结构体。

__thread也是只能用于全局存储区的变量，比如普通的全局变量或者函数内的**静态变量。** 声明的时候最好进行初始化。

```cpp
__thread int t_cachedTid = 0;
__thread char t_tidString[32];
__thread int t_tidStringLength = 6;
__thread const char* t_threadName = "unknown";
```

Muduo对线程的封装就使用了此方式。

### 使用POSIX标准中定义的pthread_key_t

Unix编程接口的POSIX标准中定义的pthread_key_t为代表的『线程特有存储』是最传统的线程本地存储，适用于所有Unix（含Mac）与Linux系统。

使用pthread_key_t遵循如下步骤：

定义key

```cpp
pthread_key_t key;
```

对线程定义的key进行初始化：

```cpp
int pthread_key_create(pthread_key_t *key, void (*destr_function) (void *))
```

和pthread_key_create对称，销毁定义的key：

```cpp
int pthread_key_delete (pthread_key_t __key);
```

设置线程的key的值（每个线程各是各的对象）：

```cpp
int pthread_setspecific (pthread_key_t __key,
				const void *__pointer)
```

获取线程key的值：

```cpp
void *pthread_getspecific (pthread_key_t __key)
```

---

**本章完结**