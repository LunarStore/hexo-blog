---
title: VS2022搭建FFMPEG + Opencv开发环境 + 如何打包项目让程序也能独立跑在其他人的电脑上？
date: 2024-10-22 12:00:00
categories: Windows环境笔记
tags:
  - 杂项
---

## 前言

本文的名字应该是我所写过的博客当中最长的，但内容以精简且保证实用为原则！

## 正文

### 首先是ffmpeg

环境搭建流程如下：

0. 在网上下载已经被编译成动态库版的ffmpeg，我的是：ffmpeg-N-113099-g46775e64f8-win64-gpl-shared。

<!-- more -->

1. 将 ffmpeg-N-113099-g46775e64f8-win64-gpl-shared/include 和 ffmpeg-N-113099-g46775e64f8-win64-gpl-shared/lib 两个目录都复制到项目源文件当中即和.vcxproj后缀的文件同一级。

2. 将 ffmpeg-N-113099-g46775e64f8-win64-gpl-shared/bin目录下，所有的.dll后缀的文件复制到.vcxproj后缀的文件同一级目录中。

3. 在vs2022中，右键项目，选择properties -> Configuration Properties -> VC++ Directories：

    1. 修改 General， 在Include Directories当中添加一项：./include。

    2. 修改 General， 在Library Directories当中添加：./lib。

4. 选择properties -> Configuration Properties -> C/C++ -> General：

    1. 在Additional Include Directories中添加一项：./include。

5. 选择properties -> Configuration Properties -> Linker -> General：

    1. 在Additional Library Directories中添加一项：./lib。

6. 选择properties -> Configuration Properties -> Linker -> Input：

    1. 在Additional Dependencies中添加依赖库的名称：

        ```bash
            avcodec.lib
            avformat.lib
            avutil.lib
            avdevice.lib
            avfilter.lib
            postproc.lib
            swresample.lib
            swscale.lib
        ```
7. 点击右下角的应用按钮，保存退出。

运行如下测试代码：

```cpp
#include <iostream>

extern "C" {
#include "libavcodec/avcodec.h"
#include "libavformat/avformat.h"
}


#include<opencv2/core/core.hpp>
#include<opencv2/highgui/highgui.hpp>
#include<opencv2/imgproc.hpp>

int main()
{
   std::cout << "Hello World!\n";
   printf("%s\n", avcodec_configuration());

   return 0;
}
```

> 输出一堆有关ffmpeg的版本以及参数信息即为配置成功

### 然后是opencv的运行环境配置：

环境搭建流程如下：

0. 同样可以在网上找到动态库版的opencv。

1. 将 opencv/build/include 和 opencv\build\x64\vc15\lib 两个目录都复制到项目源文件当中即和.vcxproj后缀的文件同一级。（PS，如果项目目录因为引入其他头文件或库，include或lib目录已经存在，则将opencv/build/include和opencv\build\x64\vc15\lib下的所有文件手动复制到项目中对应的目录即可）

2. 将 opencv\build\x64\vc15\bin 目录下，所有的.dll（更严谨一点是非.exe的所有文件）后缀的文件复制到.vcxproj后缀的文件同一级目录中。

3. 重复上节3 ~ 5步骤。

4. 选择properties -> Configuration Properties -> Linker -> Input：

    1. 在Additional Dependencies中添加依赖库的名称：

        ```bash
            opencv_world440.lib

            # 如果你需要同时安装opencv和ffmpeg的话，可以直接一次性添加如下依赖
            # avcodec.lib
            # avformat.lib
            # avutil.lib
            # avdevice.lib
            # avfilter.lib
            # postproc.lib
            # swresample.lib
            # swscale.lib
            # opencv_world440.lib
        ```
5. 点击右下角的应用按钮，保存退出。

运行如下测试代码：

```cpp
#include <opencv2/opencv.hpp>

using namespace cv;

int main() {
	const char* pic_path = "任意一张你电脑上的图片路径";
	Mat pic = imread(pic_path, 1);
	imshow("Hello World!", pic);
	waitKey();
	return 0;
}
```

> 可以看到用opencv的api成功显示了一张图片，即为配置成功。

### 在windows下对VS2022项目程序进行打包

最后就是对项目进行打包，实现让其有完整的依赖库，在其他人的电脑也能运行你的应用程序。 **说简单点其实这个过程就各种动态库、静态库的拷贝。你找一台没任何环境的新电脑作为测试环境，让你的程序在它上面运行，运行的时候会崩溃，根据报错来一点一点将所缺失的库拷贝到应用程序所在的目录当中。** 这里记录了一下只引入opencv和ffmpeg情况下打包的流程。当然微软还提供了更为强大的打包方式：Microsoft Visual Studio Installer Projects。本文所讲解的打包方式是为这些特定需求人群服务的：不需要花里胡朝的方式，只求方便的一个打包方式。

1. 将上方菜单栏的Debug改成Release。

2. 再次根据在配置ffmpeg和opencv时的过程重新配置项目的properties。

3. 最后修改：properties -> Configuration Properties -> C/C++ -> Code Generation -> Runtime Library -> Multi-threaded DLL (/MD)

4. 编译无报错

5. 新建一个目录app

6. 将项目根目录x64/Release/下所有文件拷贝到app

7. 将前面配置的include、lib**文件夹**拷贝到app

8. 将.dll**文件**拷贝到app

9. 完成迁移，app可独立在任何人的电脑上运行。

---

**本章完结**