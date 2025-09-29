---
title: Ubuntu & CentOS 配置静态IP
date: 2024-01-21 12:00:00
tags:
  - Linux环境笔记
  - 运维
---

## CentOS配置静态IP

命令：

```bash
cd /etc/sysconfig/network-scripts/

vim ifcfg-ens33

systemctl restart network
```

<!-- more -->

更改必要的项：

```
...
BOOTPROTO=static # 改成和我一致
...
ONBOOT=yes # 保持一致
IPADDR=192.168.200.8    # 配置ip地址（按需）
NETMASK=255.255.255.0   # ip地址的子网掩码（按需）
GATEWAY=192.168.200.2   # 网关（按需）
DNS1=8.8.8.8    # 配置DNS，一致就行
```


## Ubuntu配置静态IP

命令：

```bash
# 编辑配置文件
vim /etc/netplan/01-network-manager-all.yaml

# 刷新一下
netplan apply
```

更改必要的项：

在01-network-manager-all.yaml文件中renderer那一行后面追加网卡配置信息即可。**地址按需配置！**

```
network:
    version: 2
    renderer: NetworkManager
    ethernets:
        ens33:
            dhcp4: no
            addresses: [192.168.200.3/24]
            gateway4: 192.168.200.2
            nameservers:
                addresses: [114.114.114.114,8.8.8.8]
```

---

**本章完结**
