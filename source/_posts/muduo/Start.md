---
title: muduo源码阅读笔记（0、下载编译muduo）
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

## 环境搭建以及下载安装

<!-- more -->
```bash
git clone https://github.com/chenshuo/muduo.git #源码下载

# 安装依赖项
yum install cmake   # cmake安装
yum install boost-devel # boost库

# 创建build目录
cd muduo
mkdir build
cd build

# 在build目录生成makefile文件
cmake ..

# 编译
make -j4

# 安装（可忽略）
make install
```

## 编译错误的解决

**我编译时唯一遇到的错误如下：**

```bash
/root/workspace/muduo/muduo/base/TimeZone.cc:171:36: error: conversion to ‘int’ from ‘long unsigned int’ may alter its value [-Werror=conversion]
   const int time_size = v1 ? sizeof(int32_t) : sizeof(int64_t);
                                    ^
/root/workspace/muduo/muduo/base/TimeZone.cc:171:54: error: conversion to ‘int’ from ‘long unsigned int’ may alter its value [-Werror=conversion]
   const int time_size = v1 ? sizeof(int32_t) : sizeof(int64_t);
                                                      ^
cc1plus: all warnings being treated as errors
make[2]: *** [muduo/base/CMakeFiles/muduo_base.dir/TimeZone.cc.o] Error 1
make[2]: *** Waiting for unfinished jobs....
make[1]: *** [muduo/base/CMakeFiles/muduo_base.dir/all] Error 2
make: *** [all] Error 2
```

查阅资料得知：

> 该错误是由于编译时启用了 `-Werror=conversion` 选项，该选项会将警告视为错误。在这里，编译器提示可能由于从 long unsigned int 到 int 的转换而导致值的变化。

在项目的根目录的CMakeLists.txt文件中，将`-Werror`选项注释即可，此时警告不会被视为错误。

---

**本章完结**