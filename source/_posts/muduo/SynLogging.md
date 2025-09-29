---
title: muduo源码阅读笔记（1、同步日志）
date: 2024-01-10 12:00:00
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

Muduo的日志设计的非常简单，日志的格式是固定的，一条日志包括：[日志头，日志体，日志尾]。实际上，参考工业级日志的使用来看，日志还应该能支持格式变更，即用户可以自定义日志的格式，选择自己关心的日志条目进行输出，或者在日志中添加一些额外的字符来修饰日志。考虑到Muduo的核心是网络库，而不是日志库，这些点就不过多深入讨论。

## 日志消息体输出到`Impl::stream_`（简化日志的使用方式（宏定义 + 临时对象的编程技巧）

调用匿名对象的`stream()`成员函数，会返回一个类型为LogStream的引用也即`Impl::stream_`对象本身，muduo对`LogStream`类进行了详细的`>>`操作符重载，这部分代码简单易读，就不详细赘述了，这样就能将**字符串类型/数值类型**的数据使用`>>`操作符输出到`Impl::stream_`上（类似std::cout的使用）

日志消息体的输出：
<!-- more -->
```cpp
//
// CAUTION: do not write:
//
// if (good)
//   LOG_INFO << "Good news";
// else
//   LOG_WARN << "Bad news";
//
// this expends to
//
// if (good)
//   if (logging_INFO)
//     logInfoStream << "Good news";
//   else
//     logWarnStream << "Bad news";
//
#define LOG_TRACE if (muduo::Logger::logLevel() <= muduo::Logger::TRACE) \
  muduo::Logger(__FILE__, __LINE__, muduo::Logger::TRACE, __func__).stream()
#define LOG_DEBUG if (muduo::Logger::logLevel() <= muduo::Logger::DEBUG) \
  muduo::Logger(__FILE__, __LINE__, muduo::Logger::DEBUG, __func__).stream()
#define LOG_INFO if (muduo::Logger::logLevel() <= muduo::Logger::INFO) \
  muduo::Logger(__FILE__, __LINE__).stream()
#define LOG_WARN muduo::Logger(__FILE__, __LINE__, muduo::Logger::WARN).stream()
#define LOG_ERROR muduo::Logger(__FILE__, __LINE__, muduo::Logger::ERROR).stream()
#define LOG_FATAL muduo::Logger(__FILE__, __LINE__, muduo::Logger::FATAL).stream()
#define LOG_SYSERR muduo::Logger(__FILE__, __LINE__, false).stream()
#define LOG_SYSFATAL muduo::Logger(__FILE__, __LINE__, true).stream()
```

综合`Logger`以及`LogStream`的实现可知，在程序运行期间，通过上面的宏使用muduo的日志时，创建的Logger临时对象会在 **栈上开辟一段很大的空间（一般是detail::kSmallBuffer（4000byte））** 缓存日志

## 日志消息头输出到`Impl::stream_`

结合上面的宏定义来讲，在muduo中，当临时的Logger对象构造时，在其构造函数中，首先会自动输出一条日志的基本头部信息，比如对宏定义传来的时间戳进行格式化输出，输出线程所在的tid以及日志级别，如果是一条错误报告的log（此时errno非0），还会输出错误码的字符串信息。

```cpp
Logger::Impl::Impl(LogLevel level, int savedErrno, const SourceFile& file, int line)
  : time_(Timestamp::now()),
    stream_(),
    level_(level),
    line_(line),
    basename_(file)
{
  formatTime(); // 输出格式化的时间戳（这部分代码可简略的看一下，了解作用即可，无需细看。
  CurrentThread::tid(); // 缓存tid
  stream_ << T(CurrentThread::tidString(), CurrentThread::tidStringLength()); // 输出字符串形式的tid
  stream_ << T(LogLevelName[level], 6); //输出字符串形式的日志级别
  if (savedErrno != 0)  //需要输出错误就输出错误
  {
    stream_ << strerror_tl(savedErrno) << " (errno=" << savedErrno << ") ";
  }
}

// ...

Logger::Logger(SourceFile file, int line)
  : impl_(INFO, 0, file, line)
{
}
// ...
```

## 日志尾部输出到`Impl::stream_` && `Impl::stream_`对象直接输出到日志输出地（LogAppender）（利用临时对象行生命周期的特点，在析构中，同步（默认）输出日志。

这里的LogAppender可能代表磁盘上的文件、控制台std::cout、数据库等。

Muduo的日志中g_output其实是类型是函数指针的全局变量，这里通过函数指针实现了C语言的多态，Muduo默认的`g_output`是**直接**将`Impl::stream_`拼接的日志输出到控制台，即**输出是同步的**。当然，如果用户参考g_output的定义，实现了自己的输出函数，可以通过`Logger::setOutput()`接口，提供自定义函数的地址作为参数，将自定义函数安装到`g_output`上。后面Muduo实现的异步日志就是这么干的。

```cpp
void defaultOutput(const char* msg, int len)
{
  // 同步输出到终端
  size_t n = fwrite(msg, 1, len, stdout);
  //FIXME check n
  (void)n;
}

void defaultFlush()
{
  fflush(stdout);
}

/*
* 函数指针，实现多态。以及输出的解耦。
* typedef void (*OutputFunc)(const char* msg, int len);
* typedef void (*FlushFunc)();
*/
Logger::OutputFunc g_output = defaultOutput;
Logger::FlushFunc g_flush = defaultFlush;

// ...

void Logger::Impl::finish()
{
  stream_ << " - " << basename_ << ':' << line_ << '\n';    //将文件名以及日志所在行号（临时对象的构造会传入这两个信息）作为日志尾输出到Impl::stream_
}

// ...

Logger::~Logger()
{
  impl_.finish();
  const LogStream::Buffer& buf(stream().buffer());  // 获取Impl::stream_
  g_output(buf.data(), buf.length());   // 将Impl::stream_输出到日志输出地（stdout/file/database）
  if (impl_.level_ == FATAL)
  {
    g_flush();
    abort();
  }
}
```

## 日志效果
|       LogHeader                    |   LogBody       |   LogTail               |
|       ----                         |   ----          |   ----                  |
|       Time ThreadID LogLevel       |   LogMessage    |    - FileName:LineNumber|
```bash
20240109 03:21:56.970321Z  3094 INFO  Hello - Logging_test.cc:69
20240109 03:21:56.970363Z  3094 WARN  World - Logging_test.cc:70
20240109 03:21:56.970367Z  3094 ERROR Error - Logging_test.cc:71
```

## 细节明细

在 Muduo 中，为了实现日志的功能，使用了一个内部的 Impl 类来处理日志的具体实现细节。这样的设计有几个优点：

1. 封装性：
将日志的具体实现封装在 Impl 类中，使得日志系统的使用者无需关心内部的具体实现细节。这样可以减少用户对日志系统内部的依赖，提高系统的封装性和可维护性。

2. 灵活性：
Impl 类的存在使得 Muduo 可以更加灵活地修改、扩展或者替换日志系统的具体实现，而不会对外部接口产生影响。如果未来需要更换日志库、修改日志输出格式等，只需修改 Impl 类的实现而不必修改用户代码。

3. 解耦：
通过引入 Impl 类，日志系统的实现与接口之间形成了一种解耦。这种解耦有助于降低模块之间的依赖性，提高代码的灵活性和可维护性。

4. 信息隐藏：
Impl 类将具体的实现细节隐藏在类的私有部分，只暴露必要的接口给外部。这有助于控制用户对日志系统内部的访问权限，同时防止滥用或错误的使用。

muduo还统一了日志级别的字符串长度，固定为6，不足的补空格，这样，也提升了一点点性能，毕竟积少成多。同时利用模板，在编译期确定字符串长度的操作，可以参考SourceFile类的数组引用构造的实现。

```cpp
template<int N>
SourceFile(const char (&arr)[N])  // 数组引用，编译期就能确定字符串长度。
    : data_(arr),
    size_(N-1)
{
    const char* slash = strrchr(data_, '/'); // builtin function
    if (slash)
    {
    data_ = slash + 1;
    size_ -= static_cast<int>(data_ - arr);
    }
}
```

---

**本章完结**