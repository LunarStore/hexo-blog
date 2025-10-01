---
title: LevelDB源码阅读笔记（0、下载编译leveldb）
date: 2024-02-15 12:00:00
categories: 存储
tags:
  - 存储
---

**LeveDB源码笔记系列：**

[LevelDB源码阅读笔记（0、下载编译leveldb）](./Start.md)

## 本博客环境如下

```
[root@localhost build]# cat /etc/redhat-release
CentOS Linux release 7.9.2009 (Core)
```

## 简介

<!-- more -->
LevelDB是由Google使用C++开发的磁盘kv存储引擎。**基于LSMTree使用顺序写（追加写）的方式实现了极高的写性能**。RocksDB，Ceph等都可以看到它的身影。

## 环境搭建以及下载安装

命令如下：

```bash
# 下载
git clone https://github.com/google/leveldb.git

cd leveldb

mkdir build

cd build

cmake ..
```

不出所料，会报错如下：

```
...

CMake Error at CMakeLists.txt:303 (add_subdirectory):
  The source directory

    /root/workspace/leveldb/third_party/googletest

  does not contain a CMakeLists.txt file.


CMake Error at CMakeLists.txt:307 (set_property):
  set_property could not find TARGET gtest.  Perhaps it has not yet been
  created.


CMake Error at CMakeLists.txt:309 (set_property):
  set_property could not find TARGET gmock.  Perhaps it has not yet been
  created.


CMake Error at CMakeLists.txt:411 (add_subdirectory):
  The source directory

    /root/workspace/leveldb/third_party/benchmark

  does not contain a CMakeLists.txt file.


-- Looking for sqlite3_open in sqlite3
-- Looking for sqlite3_open in sqlite3 - not found
...
```

此时需要进入项目的third_party目录下载三方依赖：

```bash
cd leveldb/third_party

git clone https://github.com/google/googletest.git
git clone https://github.com/google/benchmark.git
```

由于centos7.9下载的g++默认版本（默认是c++98）是：

```
[root@localhost build]# g++ --version
g++ (GCC) 4.8.5 20150623 (Red Hat 4.8.5-44)
Copyright (C) 2015 Free Software Foundation, Inc.
This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
```

直接make也会看到报错，这是因为leveldb要求至少是c++14，故需要升级g++：

```bash
yum install -y http://mirror.centos.org/centos/7/extras/x86_64/Packages/centos-release-scl-2-3.el7.centos.noarch.rpm

yum install devtoolset-[g++版本号]-gcc-c++

# 切换g++版本，仅对当前会话有效
# 也可以使用：source /opt/rh/devtoolset-[版本号]/enable
scl enable devtoolset-[g++版本号] bash
```

开始编译：

```bash
cd leveldb/build

cmake ..

# 编译
make -j4

# 安装（可选
make install

## 在build目录下会生成一个静态库libleveldb.a
```

leveldb使用的小deamo，**该测试文件位于leveldb项目的根目录**：

```cpp
// 文件名为：test.cc
#include <cassert>
#include <iostream>
#include <string>
#include "include/leveldb/db.h"
 
int main() {
    leveldb::DB* db;
    leveldb::Options options;
    options.create_if_missing = true;
    leveldb::Status status = leveldb::DB::Open(options, "./data", &db);
    assert(status.ok());

    std::string key = "test_key";
    std::string write_value = "test_value";
    std::string read_value;

    leveldb::Status s = db->Put(leveldb::WriteOptions(), key, write_value);

    if (s.ok()){
        s = db->Get(leveldb::ReadOptions(), key, &read_value);
    }

    if (s.ok()){
        std::cout << "key=" << key << "\nvalue=" << read_value  << std::endl;
    }else{
        std::cout << "failed to find the key!" << std::endl;
    }

    delete db;
    return 0;
}

```

编译&运行：

```
// 使用如下命令也可以编译：
// g++ -I ./include -Wall -std=c++11 -o test.bin test.cc -L ./build/ -lpthread -lleveldb

[root@localhost leveldb]# g++ -I ./include -Wall -std=c++11 -o test.bin test.cc ./build/libleveldb.a -lpthread
[root@localhost leveldb]# ./test.bin 
key=test_key
value=test_value
```

---

**本章完结**