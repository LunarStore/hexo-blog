---
title: VScode使用remote ssh远程连接Ubuntu进行GO开发环境搭建
date: 2025-10-15 21:11:23
categories: Linux环境笔记
tags:
  - Golang
---

## 正文

这里需要下载版本高于1.21.x版本的go，不然vscode插件最新go插件可能不兼容！

go下载和安装：

```bash
sudo wget https://golang.google.cn/dl/go1.22.5.linux-amd64.tar.gz

sudo tar xfz go1.22.5.linux-amd64.tar.gz -C /usr/local
```
<!-- more -->

配置环境变量：

```bash
vim ~/.bashrc
# 追加
export GOROOT=/usr/local/go
export GOPATH=$HOME/go
export GOBIN=$GOPATH/bin
export PATH=$GOPATH:$GOBIN:$GOROOT/bin:$PATH
```

这里备忘下：

- GOROOT: 为go编译器安装目录。
- GOPATH: 包管理目录，所有将来下载的包都会被放在这里。
- GOBIN: 存放go编译安装可执行二进制文件的地方。

go支持两种项目包管理方式：

```bash
#使用go path进行包管理，这是旧版本go所使用的方式。
export GOPATH=/path/to/your/pro
export PATH=$PATH:$GOPATH/bin
# unset GOPATH

#使用go mod进行包管理
go env -w GO111MODULE=on
go mod init 6.5840	#在项目的根目录下进行
```

现在强烈建议使用go mod进行包管理！！！

修改go包安装代理：

```bash
go env -w GO111MODULE=on
go env -w GOPROXY=https://proxy.golang.com.cn,direct
```

vscode安装go插件。最后vscode按住ctrl + shift + p，输入Go: Install/Update Tools，勾选所有插件。等待下载完成。

参考：

- [go安装教程](https://www.oryoy.com/news/shi-yong-vscode-gao-xiao-da-jian-golang-kai-fa-huan-jing-cong-ling-kai-shi-chuang-jian-go-yu-yan-xia.html)