---
title: Payload-SDK自动升级
date: 2025-06-28 12:00:00
tags:
  - dji-PSDK
---

## 前言

自动升级旨在通过无人机更新负载上的软件，包括不限于：Payload-SDK应用、配置文件等。对于文件的传输，大疆的Payload-SDK给我们提供了两种方式：使用FTP协议和使用大疆自研的DCFTP。我们实现的自动升级是基于FTP。所以自动升级的实现可以分成3个部分：

- FTP服务的搭建
- Payload-SDK应用的修改
- sh包的制作与sh打包脚本的编写

## FTP服务的搭建

参考大疆官方做法：[链接。](https://developer.dji.com/doc/payload-sdk-tutorial/cn/function-set/advanced-function/local-update.html)

首先我们需要在负载上搭建一个vsftp服务。我司使用的是正点原子的rk3588，而rk3588默认已经在buildroot当中引入vsftp服务，我们重点只需要配置ftp配置文件：/etc/vsftpd.conf即可。配置参考如下（完整配置，可直接copy使用）：
<!-- more -->

```bash
# 允许匿名用户
anonymous_enable=YES
# 允许本地用户登录
local_enable=YES
# 允许用户写（即上传文件）
write_enable=YES
# 允许为目录配置显示信息,显示每个目录下面的message_file文件的内容
dirmessage_enable=YES

# 是否让系统自动维护上传和下载的日志文件
xferlog_enable=YES
# 是否设定FTP服务器将启用FTP数据端口的连接请求
connect_from_port_20=YES

# 是否禁止用户离开设置的根目录
chroot_local_user=NO
chroot_list_enable=NO
listen=YES
allow_writeable_chroot=YES
```

然后，参考dji本地升级文档，增加一个用户，该用户会被大疆无人机所使用：

```bash
adduser psdk_payload_ftp --home /upgrade

# 用户密码设置为：DJi_#$31

# 可以使用该命令删除用户，但经过测试，正点原子的rk3588上并不支持该命令。
userdel -r
```

重启开发板，使用 `ps aux | grep vsftpd` 可看到运行起来的vsftpd服务。客户端使用FileZilla软件可使用用户账号psdk_payload_ftp登录ftp。

在修改Payload-SDK应用前，需要将应用设置为开机自启动，方法如下：

```bash
# 新建一个文件，文件前面的数字代表优先级，数值越小优先级越大，
# 脚本当中添加如下内容：/usr/local/bin/dji_sdk_demo_linux&
# 将开发的Payload-SDK应用放到/usr/local/bin/，每次开发板启动
# 时会自动在后台启动应用。
vi /etc/init.d/S99autorun.sh

chmod +x /etc/init.d/S99autorun.sh
```

## Payload-SDK应用的修改

我们使用的SDK版本为：3.11.1，确保manifold2/application/dji_sdk_config.h定义了CONFIG_MODULE_SAMPLE_UPGRADE_ON。然后，在main函数当中，找到自动升级初始化的代码，主要做如下修改：

```c
T_DjiTestUpgradeConfig testUpgradeConfig = {
    .firmwareVersion = firmwareVersion,
    .transferType = DJI_FIRMWARE_TRANSFER_TYPE_DCFTP,
    .needReplaceProgramBeforeReboot = true
};

        |
        |
        V

T_DjiTestUpgradeConfig testUpgradeConfig = {
    .firmwareVersion = firmwareVersion,
    .transferType = DJI_FIRMWARE_TRANSFER_TYPE_FTP,
    .needReplaceProgramBeforeReboot = true
};
```

将transferType修改为DJI_FIRMWARE_TRANSFER_TYPE_FTP，文件使用vsftp传输。

对于升级功能，我们主要将注意集中在upgrade目录下的代码。

在test_upgrade.c/h当中，首先注册了四个回调：

```c
T_DjiUpgradeHandler s_upgradeHandler = {
    .EnterUpgradeMode = DjiTest_EnterUpgradeMode,
    .CheckFirmware = DjiTest_CheckFirmware,
    .StartUpgrade = DjiTest_StartUpgrade,
    .FinishUpgrade = DjiTest_FinishUpgrade
};
```

DjiTest_EnterUpgradeMode、DjiTest_CheckFirmware回调主要做升级前预处理。可根据实际情况实现。

DjiTest_StartUpgrade函数在升级包被FTP传输完毕后会被回调。

DjiTest_FinishUpgrade ？？？在升级被用户打断被调用？？？

DjiTest_StartUpgrade函数实现如下：

```c
static T_DjiReturnCode DjiTest_StartUpgrade(void)
{
    T_DjiOsalHandler *osalHandler = DjiPlatform_GetOsalHandler();

    osalHandler->MutexLock(s_upgradeStateMutex);
    s_upgradeState.upgradeOngoingInfo.upgradeProgress = 0;
    s_upgradeState.upgradeStage = DJI_UPGRADE_STAGE_ONGOING;
    osalHandler->MutexUnlock(s_upgradeStateMutex);

    return DJI_ERROR_SYSTEM_MODULE_CODE_SUCCESS;
}
```

做了两件事：首先将升级进度条置为0，然后将状态置为ONGOING。这儿状态的改变会被 DjiTest_UpgradeStartService 函数最后创建的 DjiTest_UpgradeProcessTask 线程所探测到。后面将详细讨论 DjiTest_UpgradeProcessTask 线程。

在 DjiTest_UpgradeStartService 当中，还有一段微妙而重要的代码，如下：

```c
/* ... */

returnCode = DjiTest_GetUpgradeRebootState(&isUpgradeReboot, &upgradeEndInfo);
if (returnCode != DJI_ERROR_SYSTEM_MODULE_CODE_SUCCESS) {
    USER_LOG_ERROR("Get upgrade reboot state error");
    isUpgradeReboot = false;
}

returnCode = DjiTest_CleanUpgradeRebootState();
if (returnCode != DJI_ERROR_SYSTEM_MODULE_CODE_SUCCESS) {
    USER_LOG_ERROR("Clean upgrade reboot state error");
}

osalHandler->MutexLock(s_upgradeStateMutex);
if (isUpgradeReboot == true) {
    s_upgradeState.upgradeStage = DJI_UPGRADE_STAGE_END;
    s_upgradeState.upgradeEndInfo = upgradeEndInfo;
} else {
    s_upgradeState.upgradeStage = DJI_UPGRADE_STAGE_IDLE;
}
osalHandler->MutexUnlock(s_upgradeStateMutex);

/* ... */
```

DjiTest_GetUpgradeRebootState 和 DjiTest_CleanUpgradeRebootState 函数实现在：upgrade/test_upgrade_platform_opt.c/h -> linux/commom/upgrade_platform_opt/upgrade_platform_opt_linux.c/h。

这段代码先读了一个本地文件，从里面获取一些升级状态，读完后立马将状态文件删除，如果文件不存在，说明是一次正常的开启启动，而不是因上一次升级而启动；如果文件存在，说明是应自动升级而重启，我们需要获取最后一次升级的状态，然后修改升级状态为END，同样的，DjiTest_UpgradeProcessTask线程会探测到升级状态的改变，然后向无人机报告自动升级结束。电脑上的DJI Assistant 2软件就会显示升级成功的画面。

因为重启的过程也算自动升级的一部分，所以存在这样的设计：重启前保存升级状态，重启后读取上一次升级状态，通知无人机升级完成。

下面详细看看 DjiTest_UpgradeProcessTask 函数的实现：

```c
static void *DjiTest_UpgradeProcessTask(void *arg)
{
    T_DjiOsalHandler *osalHandler = DjiPlatform_GetOsalHandler();
    T_DjiUpgradeState tempUpgradeState;
    T_DjiUpgradeEndInfo upgradeEndInfo;
    T_DjiReturnCode returnCode;

    while (1) {
        osalHandler->MutexLock(s_upgradeStateMutex);
        tempUpgradeState = s_upgradeState;
        osalHandler->MutexUnlock(s_upgradeStateMutex);

        if (tempUpgradeState.upgradeStage == DJI_UPGRADE_STAGE_ONGOING) {
            if (s_isNeedReplaceProgramBeforeReboot) {
                // Step 1 : 替换最新文件
                returnCode = DjiTest_ReplaceOldProgram();

                osalHandler->TaskSleepMs(1000);
                osalHandler->MutexLock(s_upgradeStateMutex);
                s_upgradeState.upgradeStage = DJI_UPGRADE_STAGE_ONGOING;
                s_upgradeState.upgradeOngoingInfo.upgradeProgress = 20;
                DjiUpgrade_PushUpgradeState(&s_upgradeState);
                osalHandler->MutexUnlock(s_upgradeStateMutex);

                // Step 2 : 清空升级目录
                returnCode = DjiTest_CleanUpgradeProgramFileStoreArea();

                osalHandler->TaskSleepMs(1000);
                osalHandler->MutexLock(s_upgradeStateMutex);
                s_upgradeState.upgradeStage = DJI_UPGRADE_STAGE_ONGOING;
                s_upgradeState.upgradeOngoingInfo.upgradeProgress = 30;
                DjiUpgrade_PushUpgradeState(&s_upgradeState);
                osalHandler->MutexUnlock(s_upgradeStateMutex);
            }

            // Step 3 :模拟升级过程
            do {
                osalHandler->TaskSleepMs(1000);
                osalHandler->MutexLock(s_upgradeStateMutex);
                s_upgradeState.upgradeStage = DJI_UPGRADE_STAGE_ONGOING;
                s_upgradeState.upgradeOngoingInfo.upgradeProgress += 10;
                tempUpgradeState = s_upgradeState;
                DjiUpgrade_PushUpgradeState(&s_upgradeState);
                osalHandler->MutexUnlock(s_upgradeStateMutex);
            } while (tempUpgradeState.upgradeOngoingInfo.upgradeProgress < 100);

            // Step 4 :将升级状态持久化保存到状态文件当中。
            osalHandler->MutexLock(s_upgradeStateMutex);
            s_upgradeState.upgradeStage = DJI_UPGRADE_STAGE_DEVICE_REBOOT;
            s_upgradeState.upgradeRebootInfo.rebootTimeout = DJI_TEST_UPGRADE_REBOOT_TIMEOUT;
            DjiUpgrade_PushUpgradeState(&s_upgradeState);
            osalHandler->MutexUnlock(s_upgradeStateMutex);
            osalHandler->TaskSleepMs(1000); // sleep 1000ms to ensure push send terminal.

            upgradeEndInfo.upgradeEndState = DJI_UPGRADE_END_STATE_SUCCESS;
            returnCode = DjiTest_SetUpgradeRebootState(&upgradeEndInfo);

            // Step 5 :重启设备
            returnCode = DjiTest_RebootSystem();
            while (1) {
                osalHandler->TaskSleepMs(500);
            }
        } else if (s_upgradeState.upgradeStage == DJI_UPGRADE_STAGE_END) {
            // Step 6 :升级重启完成，升级完成被探测到。通知无人机，反馈到DJI Assistant 2 (Enterprise Series)，反馈升级成功完成。
            osalHandler->MutexLock(s_upgradeStateMutex);
            DjiUpgrade_PushUpgradeState(&s_upgradeState);
            osalHandler->MutexUnlock(s_upgradeStateMutex);
        }

        osalHandler->TaskSleepMs(500);
    }
}
```

完整的升级流程是：

1. FTP文件传输完毕

2. 回调DjiTest_StartUpgrade，设置升级进度为0，升级状态为ONGOING。

3. DjiTest_UpgradeProcessTask线程探测到升级状态为ONGOING。

4. 升级应用。反馈进度。

5. 清空升级临时文件。反馈进度。

6. 保存升级状态到状态文件。

7. 重启系统。

8. 初始化时DjiTest_UpgradeStartService读取状态文件。并设置升级状态为END。

9. DjiTest_UpgradeProcessTask线程探测到升级状态为END。

10. 反馈进度，DJI Assistant 2收到反馈，显示升级完成。

因为我们的升级包使用的shell嵌入二进制数据的方式，所以，相应的，DjiTest_ReplaceOldProgram的逻辑被替换为：将升级包命名为upgrade.sh，并赋予可执行权限，然后执行sh脚本，sh脚本会自动将各个文件替换为最新的。由于rk3588 reboot命令并不支持任何参数，所以需要将upgrade_platform_opt_linux.c当中DjiUpgradePlatformLinux_RebootSystem函数实现的reboot命令后面的参数删除掉。**还需要注意的是，升级包一定要命名为 PSDK_APPALIAS_V01.00.00.00.bin 形式，后面的版本用户可以根据实际情况修改。**

## sh包的制作与sh打包脚本的编写

所谓sh包，就是将我们的二进制文件（不管是可执行文件，还是tarboll等）嵌入到shell脚本当中，简单来说，就是一个开头是一小段是shell脚本，末尾都是二进制数据（也可以是base64加密后的数据）的文件。

通常来说，开头的那一段shell脚本是固定套路如下：

```bash
#!/bin/sh
PATH=/usr/bin:/bin
umask 022
md5=3e2ec953a6505b0ef8ad4e53babd4b43
pre_install()
{
    echo "Preparing installation environment (simplified)..."
    mkdir ./install.tmp.$$
}
check_sum()
{
    if [ -x /usr/bin/md5sum ]&&[ -f "install.tmp.$$/extract.$$" ]; then
        echo "Checking md5..."
        sum_tmp=$(/usr/bin/md5sum install.tmp.$$/extract.$$ | awk '{print $1}')
        if [ $sum_tmp != $md5 ]; then
            echo "File md5 mismatch, please check file integrity, exiting!"
            exit 1
        fi
    else
        echo "Cannot find md5sum command or file not extracted, exiting"
        exit 1
    fi
}
extract()
{
    echo "Extracting files from script"
    line_number=`awk '/^__BIN_FILE_BEGIN__/ {print NR + 1; exit 0; }' "$0"`    
    # tail -n +$line_number "$0" >./install.tmp.$$/extract.$$
    tail -n +$line_number "$0" >./install.tmp.$$/extract_tmp.$$
    base64 -d ./install.tmp.$$/extract_tmp.$$ >./install.tmp.$$/extract.$$
}
install()
{
    echo "Installing (simplified)..."
    mv install.tmp.$$/extract.$$ install.tmp.$$/extract.tar.gz
    tar -xvf install.tmp.$$/extract.tar.gz -C install.tmp.$$/

    # do something
    # install file...
    # 将旧文件替换为./install.tmp.$$/dc_app/目录下的文件。
    # mv、cp等，如下：
    # mv -f ./install.tmp.$$/dc_app/dji_sdk_demo_linux /usr/local/bin/dji_sdk_demo_linux
    # chmod 777 /usr/local/bin/dji_sdk_demo_linux
}
post_install()
{
    echo "Configuring (simplified)..." 
    echo "Cleaning up temporary files"
    rm -rf install.tmp.$$
}

main()
{
    pre_install
    extract
    check_sum
    install
    post_install
    exit 0
}

main
#The binary file starts below
__BIN_FILE_BEGIN__

```
最后的一个回车换行不要删除！！！

我们以tarboll为例，将需要升级的文件按约定好的命名，并放到dc_app（名字可以随便取）目录下面，使用tar命令打包

```bash
tar -czvf dc_app.tar.gz ./dc_app
```

sh包制作流程如下：

1. 新建一个文件object.sh，将上面这段代码包括末尾的回车换行拷贝到object.sh当中。

2. 计算tarboll的md5值：
    ```bash
    lunar@lunar-ThinkStation-K-C2N00:~/workspace/uav_temp/build_package$ md5sum ./dc_app.tar.gz
    e12bfd83e61975032cbc03bc570002ec  ./dc_app.tar.gz
    ```

3. 将上面sh脚本当中的全局变量md5，替换为e12bfd83e61975032cbc03bc570002ec。

4. 使用base64命令，将tarboll进行base64编码，并追加到sh文件末尾。
    ```bash
    base64 dc_app.tar.gz >> object.sh
    ```

5. 将object.sh更名为PSDK_APPALIAS_V01.00.00.01.bin。

最后，拿到PSDK_APPALIAS_V01.00.00.01.bin升级包后，可以通过DJI Assistant 2 连接到无人机对负载进行升级。

当然，上面1~5打包的过程可以另外编写一个shell脚本，输入需要升级的文件，然后直接输出.bin文件。参考如下：

```bash
#!/bin/bash

# =============================================
# Script: create_pack.sh
# Description: Package files, calculate MD5, modify object.sh and append base64 encoded data
# Usage: ./script.sh <version> <file1> <file2> <file3> ...
# Example: ./create_pack.sh V01.02.03.04 app.cpp app app.conf
# =============================================

# Validate arguments
if [ $# -lt 2 ]; then
    echo "Error: Insufficient arguments!"
    echo "Usage: $0 <version> <file1> <file2> ..."
    echo "Example: $0 V01.02.03.04 app.cpp app app.conf"
    exit 1
fi

VERSION="$1"
shift # Remove version argument, remaining are files
SOURCE_FILES=("$@")
OBJECT_SCRIPT="object.sh"
TEMP_DIR="temp_pack_dir_$$"
OUTPUT_NAME="PSDK_APPALIAS_${VERSION}.bin"

# Check required tools
if ! command -v md5sum &> /dev/null || ! command -v base64 &> /dev/null; then
    echo "Error: Required tools (md5sum/base64) not found!"
    exit 1
fi

# Create temporary directory structure
mkdir -p "${TEMP_DIR}/dc_app" || { echo "Error: Failed to create temp directory"; exit 1; }

echo "Step 1/6: Copying files to temporary directory..."
for file in "${SOURCE_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo "Error: File $file not found!"
        exit 1
    fi
    cp -v "$file" "${TEMP_DIR}/dc_app/" || exit 1
done

echo "Step 2/6: Creating compressed archive..."
TARBALL_NAME="dc_app_${VERSION}.tar.gz"
tar -czvf "$TARBALL_NAME" -C "$TEMP_DIR" dc_app || { echo "Error: Compression failed"; exit 1; }

echo "Step 3/6: Calculating MD5 checksum..."
NEW_MD5=$(md5sum "$TARBALL_NAME" | awk '{print $1}')
echo "Generated MD5: $NEW_MD5"

if [ ! -f "$OBJECT_SCRIPT" ]; then
    echo "Error: ${OBJECT_SCRIPT} not found!"
    exit 1
fi

echo "Step 4/6: Updating MD5 in ${OBJECT_SCRIPT}..."
cp -p "$OBJECT_SCRIPT" "${OBJECT_SCRIPT}.bak" || exit 1
sed -i "s/^md5=.*/md5=${NEW_MD5}/" "$OBJECT_SCRIPT" || { echo "Error: MD5 replacement failed"; exit 1; }

echo "Step 5/6: Generating final output ${OUTPUT_NAME}..."
{
    cat "$OBJECT_SCRIPT"
    base64 "$TARBALL_NAME" || exit 1
} > "$OUTPUT_NAME" || { echo "Error: Failed to create output file"; exit 1; }

chmod +x "$OUTPUT_NAME"

echo "Step 6/6: Cleaning temporary files..."
rm -rf "$TEMP_DIR" "$TARBALL_NAME"

echo "========================================"
echo "Operation completed successfully!"
echo "Output file: ${OUTPUT_NAME}"
echo "MD5 checksum: ${NEW_MD5}"
echo "Backup created: ${OBJECT_SCRIPT}.bak"
echo "========================================"
```

---

**本章完结**