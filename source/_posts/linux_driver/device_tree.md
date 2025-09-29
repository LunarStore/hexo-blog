---
title: Linux驱动开发——设备树随记
date: 2024-11-17 12:00:00
tags:
  - 驱动开发
---

## 前言

在嵌入式Linux这块，对设备树一直都没怎么去了解，一直是模模糊糊的。所以最近也是被老大赶鸭子上架，快速跟着正点原子的驱动开发的课程学了一下。感觉对设备树的认识也是更清晰了一点。同样借着此篇博客记录了一下我的理解。起一个备忘的作用也希望能帮到其他人。

## 正文

其实类比理解的话DTS相当于.c源文件，文件描述板级设备信息。一个平台或机器对应一个.dts源文件。

- DTI相当于c语言的头文件。

- DTC相当于于gcc，可以将dts文件编译生成dtb文件

- DTB相当于二进制.o文件，由DTC将DTS编译生成。
<!-- more -->

严格来讲，DTI是描述芯片以及芯片周围的一些外设（片上外设）的，比如：CPU的一些参数、总线、总线上的中断控制器、时钟、GPIO的参数、UART控制器、I2C控制器、SPI控制器等等。这些东西都是和芯片强绑定的。只要是你用IMX6ULL这颗芯片，那么它的片上外设就是这些。不存在不同。

而DTS则会描述具体的片外外设的一些参数信息。比如这个外设接在哪个GPIO口？这个外设要设置什么样的GPIO属性？等等。片外外设是围绕着IMX6ULL这颗芯片来设计不同的板载。比如利用IMX6ULL芯片设计出一个路由器、摄像头、交换机等。因为共用一个芯片。所以它们一定会使用同一个DTI。

一个节点名（node name）命名形如`name@unit_addr`，从命名上可以分成两个部分：@前面代表name（可重复）、@后面代表该节点外设在内存当中对应的首地址。特别的，如下所示name之前有个冒号和简称。冒号前面的称为标签（也可以理解为别名，不可重复），可以代替节点名来访问改节点。当节点代表一个设备时，比如一个I2C设备，@后面的数字代表设备的从机地址。

```dts
/{
	intc: interrupt-controller@00a01000 {
        /* ... */
	};
}
```

使用&符号可以向标签所代表的节点当中添加一些所需要设置的属性。比如

在开发板启动后，可以在文件系统当中，看到设备树的一些信息。在目录/proc/device-tree下，使用文件树的方式构建了设备树（节点作为目录、属性作为文件）。

## 两个特殊的节点：aliases和chosen

对于aliases节点其实翻译过来就是别名，以imx6ull.dtsi文件为例：

```dts
/ {
	aliases {
		gpio0 = &gpio1;
		gpio1 = &gpio2;
		i2c0 = &i2c1;
		i2c1 = &i2c2;
		serial0 = &uart1;
		serial1 = &uart2;
		serial2 = &uart3;
		serial7 = &uart8;
        /* ... */
	};
    soc {
        aips1 {
            gpio1: gpio@0209c000 {
                /* ... */
			};
            gpio2: gpio@020a0000 {
                /* ... */
			};
            /* ... */
        }
    }
}
```

可以看到，其实就是为各个标签起了一个别名。但是这就有一个疑问：标签和别名之间的区别是什么？

根据其他人提供的线索去查阅文档：[https://elinux.org/Device_Tree_Mysteries#Label_vs_aliases_node_property](https://elinux.org/Device_Tree_Mysteries#Label_vs_aliases_node_property)

其中关键的一段话是：The aliases are not used directly in the device tree source, but are instead dereferenced by the Linux kernel. When a path is provided to of_find_node_by_path() or of_find_node_opts_by_path(), if the path does not begin with a "/" then the first element of the path must be a property name in the "/aliases" node. That element is replaced with the full path from the alias.

简单来讲，DTS、DTI文件无法使用别名，只能使用标签。标签最终会被解释为节点的绝对路径。而别名是被内核所使用的，当内核调用`of_find_node_by_path`或`of_find_node_opts_by_path`函数时，如果提供的的节点的路径不是绝对路径的话，就会把它视作在aliases节点下定义的别名，通过别名来获得节点的绝对路径。

对于chosen节点，查阅正点原子的IMX6ULL驱动开发指南得43.6.2小结得知，Uboot在启动内核前会向chosen添加一个bootargs属性，其内容为Uboot环境变量当中的bootargs的值。同时，bootargs也会作为内核启动的cmdline参数。

## 标准属性

### compatible属性

compatible属性会维护一个形如：`manufacture,model`的驱动兼容列表，驱动程序会根据该列表判断是否与设备兼容。

例如现在有一个设备节点compatible属性值如下：

```dts
compatible = "fsl,imx6ul-evk-wm8960","fsl,imx-audio-wm8960";
```

根据正点原子手册描述得知：上述compatible属性值有两个，分别为“fsl,imx6ul-evk-wm8960”和“fsl,imx-audio-wm8960”，其中“fsl”表示厂商是飞思卡尔，“imx6ul-evk-wm8960”和“imx-audio-wm8960”表示驱动模块名字。sound这个设备首先使用第一个兼容值在 Linux 内核里面查找，看看能不能找到与之匹配的驱动文件，如果没有找到的话就使用第二个兼容值查。

一般驱动程序文件都会有一个 OF 匹配表，此 OF 匹配表保存着一些 compatible 值，如果设备节点的 compatible 属性值和 OF 匹配表中的何一个值相等，那么就表示设备可以使用这个驱动。

### model属性

代表设备名

### status属性

表示设备可操作的状态：

|	值		|	含义				|
|	:-:		|	:-:					|
|	okay	|	表示设备是可操作的	|
|	disable	|	设备当前不可操作，但未来可能可操作，比如那些热插拔的设备		|
|	fail/fail-xxx	|	设备出错了	|

### reg、#address-cells和#size-cells 属性

#address-cells 和#size-cells 这两个属性可以用在任
何拥有子节点的设备中。一般和reg属性配合使用使用。reg属性一般格式如下：

```dts
reg = <address1 length1>,	// cell1: addr + len
	<address2 length2>,		// cell2: addr + len
	<address3 length3>,		// cell3: addr + len
	...;
```

当父节点定义了#address-cells和#size-cells 属性，子节点在定义reg属性时一个cell就受到父节点定义的#address-cells和#size-cells 属性的约束，**比如当父节点定义#address-cells为2、#size-cells为1时，就说明子节点reg属性当中一个cell由：两个地址 + 一个长度组成**，当然典型的#address-cells和#size-cells 属性的值分别为1、1，这样reg值就和上面代码块所展示的一样。

这里还是一三个示例来说明一下：

**对于#address-cells为1，#size-cells为0的情况：**

```dts
spi4 {
	compatible = "spi-gpio";
	#address-cells = <1>;
	#size-cells = <0>;
	gpio_spi: gpio_spi@0 {
		compatible = "fairchild,74hc595";
		reg = <0>;

	};
};
```

表示gpio_spi当中的reg属性cell只有address值。

```dts
reg = <address1>,	// cell1: addr
	<address2>,		// cell2: addr
	<address3>,		// cell3: addr
	...;
```

**对于#address-cells为1，#size-cells为1的情况：**

```dts
spba-bus@02000000 {
	compatible = "fsl,spba-bus", "simple-bus";
	#address-cells = <1>;
	#size-cells = <1>;
	reg = <0x02000000 0x40000>;
	ranges;

	ecspi1: ecspi@02008000 {
		#address-cells = <1>;
		#size-cells = <0>;
		compatible = "fsl,imx6ul-ecspi", "fsl,imx51-ecspi";
		reg = <0x02008000 0x4000>;
		status = "disabled";
	};
}
```

表示ecspi1当中的reg属性一个cell组成是：address length。

```
reg = <address1 length1>,	// cell1: addr + len
	<address2 length2>,		// cell2: addr + len
	<address3 length3>,		// cell3: addr + len
	...;
```

**对于#address-cells为2，#size-cells为1的情况：**

```dts
external-bus {
         #address-cells = <2>
         #size-cells = <1>;
        ...

         ethernet@0,0 {
             compatible = "smc,smc91c111";
             reg = <0 0 0x1000>;
         };

         i2c@1,0 {
             compatible = "acme,a1234-i2c-bus";
             #address-cells = <1>;
             #size-cells = <0>;
             reg = <1 0 0x1000>;
         };

         flash@2,0 {
             compatible = "samsung,k8f1315ebm", "cfi-flash";
             reg = <2 0 0x4000000>;
         };
	};    
```

表示i2c当中的reg属性一个cell组成是：address_MSB（64位地址最高有效位） address_LSB（64位地址最低有效位） length。（**注：一个cell当中一个单元是32位的**）

```dts
reg = <address1_MSB address1_LSM length1>,
	<address2_MSB address2_LSB length2>,
	<address3_MSB address3_LSB length3>,
	...;
```

更一般的：只要子节点需要描述多个设备区域，就可以在 reg 属性中连续定义多个地址和大小。

```dts
parent {
    #address-cells = <2>;
    #size-cells = <1>;

    child@0 {
        reg = <0x00000000 0x10000000 0x1000>,  // 第一段地址 + 大小
              <0x00000000 0x20000000 0x2000>,  // 第二段地址 + 大小
              <0x00000001 0x30000000 0x3000>;  // 第三段地址 + 大小
    };
};
```

解释：

1. 每个设备区域由 #address-cells 和 #size-cells 定义的单元描述。

	- 比如 0x00000000 0x10000000 是地址，0x1000 是大小。

2. reg 属性用逗号分隔，表示多个设备区域。

3. 每个设备区域对应硬件设备的不同地址空间。

**特别注意的是#address-cells、#size-cells定义的都是子节点的reg规则，而不是本节点！！！**

### 其他属性

对于range属性，IMX6ULL设备树当中是没有使用的（有，但都为空），它的值一般格式为：

```dts
<child-bus-address,parent-bus-address,length>
```

当父节点定义此属性时，代表将子节点从child-bus-address地址开始，映射到父节点起始地址parent-bus-address处，并映射length这么长的一个范围。

对于name属性：name 属性值为字符串，name 属性用于记录节点名字，name 属性已经被弃用，不推荐使用name 属性，一些老的设备树文件可能会使用此属性

device_type属性：属性值为字符串，IEEE 1275 会用到此属性，用于描述设备的 FCode，但是设备树没有 FCode，所以此属性也被抛弃了。此属性只能用于 cpu 节点或者 memory 节点。imx6ull.dtsi 的 cpu0 节点用到了此属性，内容如下所示：

```dts
cpu0: cpu@0 {
	compatible = "arm,cortex-a7";
	device_type = "cpu";
}
```

对于根节点的compatible属性：。Linux 内核会通过根节点的 compoatible 属性查看是否支持此设备，如果支持的话才会启动 Linux 内核。

## OF函数 —— 驱动和设备树交互的桥梁

OF函数定义的头文件：include/linux/of.h

### 查找节点的 OF 函数

- `struct device_node *of_find_node_by_name(struct device_node *from, 
		const char *name)`

	描述：通过节点名字查找指定的节点。
	- from：开始查找的节点，如果为 NULL 表示从根节点开始查找整个设备树。
	- name：要查找的节点名字。
	- 返回值：找到的节点，如果为 NULL 表示查找失败。

- `struct device_node *of_find_node_by_type(struct device_node *from, 
		const char *type)`

	描述：通过 device_type 属性查找指定的节点。（因为device_type用到很少，所以该函数用的也很少）
	- from：开始查找的节点，如果为 NULL 表示从根节点开始查找整个设备树。
	- type：要查找的节点对应的 type 字符串，也就是 device_type 属性值。
	- 返回值：找到的节点，如果为 NULL 表示查找失败。

- `struct device_node *of_find_compatible_node(struct device_node *from,
		const char *type, 
		const char *compatible)`

	描述：根据 device_type 和 compatible 这两个属性查找指定的节点。
	- from：开始查找的节点，如果为 NULL 表示从根节点开始查找整个设备树。
	- type：要查找的节点对应的 type 字符串，也就是 device_type 属性值，可以为 NULL，表示忽略掉 device_type 属性。
	- compatible：要查找的节点所对应的 compatible 属性列表。
	- 返回值：找到的节点，如果为 NULL 表示查找失败

- `struct device_node *of_find_matching_node_and_match(struct device_node *from,
		const struct of_device_id *matches,
		const struct of_device_id **match)`

	描述：通过 of_device_id 匹配表来查找指定的节点。
	- from：开始查找的节点，如果为 NULL 表示从根节点开始查找整个设备树。
	- matches：of_device_id 匹配表，也就是在此匹配表里面查找节点。
	- match：找到的匹配的 of_device_id。
	- 返回值：找到的节点，如果为 NULL 表示查找失败

- `inline struct device_node *of_find_node_by_path(const char *path)`

	描述：通过路径来查找指定的节点。
	- path：带有全路径的节点名，可以使用节点的别名，比如“/backlight”就是 backlight 这个节点的全路径。
	- 返回值：找到的节点，如果为 NULL 表示查找失败。

- `struct device_node *of_get_parent(const struct device_node *node)`

	描述：用于获取指定节点的父节点(如果有父节点的话)。
	- node：要查找的父节点的节点。
	- 返回值：找到的父节点。

- `struct device_node *of_get_next_child(const struct device_node *node,
		struct device_node *prev)`

	描述：数用迭代的方式查找子节点。
	- node：父节点。
	- prev：前一个子节点，也就是从哪一个子节点开始迭代的查找下一个子节点。可以设置为NULL，表示从第一个子节点开始。
	- 返回值：找到的下一个子节点。

### 获取属性值的 OF 函数

设备树的属性在内核当中以一个结构体的形式存在，它的定义如下：

```c
struct property {
	char *name; /* 属性名字 */
	int length; /* 属性长度 */
	void *value; /* 属性值 */
	struct property *next; /* 下一个属性 */
	unsigned long _flags;
	unsigned int unique_id;
	struct bin_attribute attr;
};
```

- `property *of_find_property(const struct device_node *np,
		const char *name,
		int *lenp)`

	描述：查找指定节点的属性名为name的属性值。
	- np：设备节点。
	- name： 属性名字。
	- lenp：属性值的字节数。
	- 返回值：找到的属性。

- `int of_property_count_elems_of_size(const struct device_node *np,
		const char *propname,
		int elem_size)`

	描述：获取属性中元素的数量，比如 reg 属性值是一个数组，那么使用此函数可以获取到这个数组的大小。
	- np：设备节点。
	- proname： 需要统计元素数量的属性名字。
	- elem_size：元素长度。
	- 返回值：得到的属性元素数量。

- `int of_property_read_u32_index(const struct device_node *np,
		const char *propname,
		u32 index, 
		u32 *out_value)`

	描述：从属性中获取指定标号的 u32 类型数据值(无符号 32位)，比如某个属性有多个 u32 类型的值，那么就可以使用此函数来获取指定标号的数据值。
	- np：设备节点。
	- proname： 要读取的属性名字。
	- index：要读取的值标号。
	- out_value：读取到的值
	返回值：0 读取成功，负值，读取失败，-EINVAL 表示属性不存在，-ENODATA 表示没有要读取的数据，-EOVERFLOW 表示属性值列表太小。

- `int of_property_read_ux_array(const struct device_node *np,
		const char *propname, 
		ux *out_values, 
		size_t sz)`（x = 8, 16, 32, 64）

	描述：可以读取属性中 u8、u16、u32 和 u64 类型的数组数据，比如大多数的 reg 属性都是数组数据，可以使用这 4 个函数一次读取出 reg 属性中的所有数据。
	- np：设备节点。
	- proname： 要读取的属性名字。
	- out_value：读取到的数组值，分别为 u8、u16、u32 和 u64。
	- sz：要读取的数组元素数量。
	- 返回值：0，读取成功，负值，读取失败，-EINVAL 表示属性不存在，-ENODATA 表示没有要读取的数据，-EOVERFLOW 表示属性值列表太小。

- `int of_property_read_ux(const struct device_node *np, 
		const char *propname,
		ux *out_value)`（x = 8, 16, 32, 64）

	描述：是用于读取这种只有一个整形值的属性，可以读取 u8、u16、u32 和 u64 类型属性值。
	- np：设备节点。
	- proname： 要读取的属性名字。
	- out_value：读取到的数组值。
	- 返回值：0，读取成功，负值，读取失败，-EINVAL 表示属性不存在，-ENODATA 表示没有要读取的数据，-EOVERFLOW 表示属性值列表太小。

- `int of_property_read_string(struct device_node *np, 
		const char *propname,
		const char **out_string)`

	描述：读取属性中字符串值。
	- np：设备节点。
	- proname： 要读取的属性名字。
	- out_string：读取到的字符串值。
	- 返回值：0，读取成功，负值，读取失败。

- `int of_n_addr_cells(struct device_node *np)`、`int of_n_size_cells(struct device_node *np)`

	描述：分别可以获取设备的#address-cells、#size-cells属性值。
	- np：设备节点。
	- 返回值：#address-cells、#size-cells属性值。

- `int of_device_is_compatible(const struct device_node *device,
		const char *compat)`

	描述：查看节点的 compatible 属性是否有包含 compat 指定的字符串。
	- device：设备节点。
	- compat：要查看的字符串。
	- 返回值：0，节点的 compatible 属性中不包含 compat 指定的字符串；正数，节点的 compatible
	- 属性中包含 compat 指定的字符串。

了解完操作设备树的OF函数之后，其实我们就应该知道，所谓设备树的属性，除了常用的reg之外，在设备树文件当中，存在很多其他的一些厂商自定义的属性，这些属性专门为他们的芯片/设备服务的。我们也可以为一个节点自定义一个属性。最开始接触设备树的时候，因为没有任何单片机的基础，对于设备树文件当中出现的GPIO、I2C、SPI、PWM、UART等陌生的词汇没有任何概念，在有了一点单片机的基础后，再来看设备树这些概念，其实就很好理解了，对于某一个节点，为什么要有这些属性都大概能知道其原因。

---

**本章完结**