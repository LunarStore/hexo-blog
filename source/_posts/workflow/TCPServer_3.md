---
title: WorkFlow源码剖析——Communicator之TCPServer（下）
date: 2024-11-07 12:00:00
categories: 服务器框架
tags:
  - 高性能服务器框架
---

## 前言

系列链接如下：

[WorkFlow源码剖析——GO-Task 源码分析](https://blog.csdn.net/m0_52566365/article/details/142903964)

[WorkFlow源码剖析——Communicator之TCPServer（上）](https://blog.csdn.net/m0_52566365/article/details/143452443)

[WorkFlow源码剖析——Communicator之TCPServer（中）](https://blog.csdn.net/m0_52566365/article/details/143493066)

[WorkFlow源码剖析——Communicator之TCPServer（下）](https://blog.csdn.net/m0_52566365/article/details/143605123)

终于来到TCPServer最后一部分，前面两篇博客已经深入分析了WorkFlow底层poller和Communicator的实现细节，本篇博客将会从整体视角，整合前面所讲的poller以及Communicator形成最终的TCPServer。

同样放上workflow开源项目的Github地址：[https://github.com/sogou/workflow](https://github.com/sogou/workflow)

和GO-Task的实现类似，尤其需要注意对基类SubTask、CommSession虚函数的重写。如果你看过GO-Task的实现，本文最终所讲的TCPServer任务其实差不多。因为TCPServer的继承树和GO-Task的继承树不能说相似，只能说一模一样。对称性对框架的设计真的很重要，我认为对称思想（也可以说成抽象思想）是优雅的象征。并且对称性可以帮我们减少出BUG的风险。如果你刷过的LeetCode，你一定会发现，在解答那些对边界条件要求很高的题目时，如果你能给各种情况抽象出一套统一的逻辑说词，大概率就不会wa。

<!-- more -->

重申一下，本系列暂时集中分析workflow的TCPServer端的架构。对于客户端，后面有时间了会另起一个系列进行讲解。像CommSchedGroup、CommSchedTarget、CommSchedObject等属于客户端独有功能。CommSchedGroup主要功能是对客户端的连接按负载（引用数量）进行一个堆排序管理。读者可先忽略掉这些内容。并且因为有些类的设计是同时兼顾客户端和服务端的（如：CommRequest、等），这点在阅读源码的时候需要有自己的判断能力。不要被绕进去了！

## 正文

我们就顺从[WorkFlow GO-Task 源码分析](https://blog.csdn.net/m0_52566365/article/details/142903964)的方式，以workflow给的http_echo_server的示例作为本文的切入点：

### 用法

go-task的用法示例如下：

```cpp
#include <stdio.h>
#include <utility>
#include "workflow/HttpMessage.h"
#include "workflow/HttpUtil.h"
#include "workflow/WFServer.h"
#include "workflow/WFHttpServer.h"
#include "workflow/WFFacilities.h"

void process(WFHttpTask *server_task) {
	protocol::HttpRequest *req = server_task->get_req();
	protocol::HttpResponse *resp = server_task->get_resp();

    /* 根据http请求进行一些业务处理，然后构造出回复报文。 */
    /* ... */
}

int main(int argc, char *argv[]) {
	unsigned short port;

	if (argc != 2) {
		fprintf(stderr, "USAGE: %s <port>\n", argv[0]);
		exit(1);
	}

	signal(SIGINT, sig_handler);

	WFHttpServer server(process);
	port = atoi(argv[1]);
	if (server.start(port) == 0) {
		wait_group.wait();
		server.stop();
	} else {
		perror("Cannot start server");
		exit(1);
	}

	return 0;
}
```

从workflow的httpserver的使用demo当中可以了解到，核心框架有三步：

1. 将http处理回调函数作为参数，构造一个server对象。

2. 调用start接口，启动server。

3. wait_group.wait()阻塞，等待服务的结束。

看到这三步流程，我们其实应该是一脸蒙的，根本无法猜到它底层是如何起服务的；当连接来到时又是如何回调上面的处理函数的。别着急我们先结合前面两篇博客，尽力而为的猜：

1. 看到了process回调函数当中开头定义的两个**指针变量**req和resp都是来自server_task。结合tcp服务端在读取来自客户端的请求报文并解析前会调用Communicator::create_request函数创建一个in对象作为报文解析器，而in又是由session创建，**而在服务端session又是由CommService创建**。同时Communicator::reply接口是以session作为参数，最终tcpserver在发送回复时会取出session当中的out并发送给客户端，很明显的是：out显然是服务端对客户端请求的回复报文。所以种种迹象都表明server_task当中req、resp和session的in和out有着紧密联系。

2. server.start接口一定会调用创建socket，绑定socket、监听sokcet。而这些流程在Communicator当中有提供接口，对应：Communicator::bind。Communicator::bind函数只有一个唯一的参数：CommService，但综合CommService头文件的定义来看，因为它里面有一个纯虚函数：new_session，显然CommService是一个虚基类，这意味着它无法实例化对象。所以一定有继承CommService的子类。

综上，1、2两点都指向了一个关键词————CommService。

### 探究WFHttpServer

根据上小节得到的线索，我们深入跟到WFHttpServer当中去，它的继承树如下：

```
{ WFHttpServer == WFServer<protocol::HttpRequest, protocol::HttpResponse> } -> WFServerBase -> CommService
```

所以，WFHttpServer实际上是**模板类WFServer**的一个**成员函数全特化**实现。下面集中分析一下WFServer和WFServerBase：

首先是WFServer模板类：

```cpp
template<class REQ, class RESP>
class WFServer : public WFServerBase {
public:
	WFServer(const struct WFServerParams *params,
			 std::function<void (WFNetworkTask<REQ, RESP> *)> proc) :
		WFServerBase(params),
		process(std::move(proc)) {  }

	WFServer(std::function<void (WFNetworkTask<REQ, RESP> *)> proc) :
		WFServerBase(&SERVER_PARAMS_DEFAULT),
		process(std::move(proc)) {  }

protected:
	virtual CommSession *new_session(long long seq, CommConnection *conn);

protected:
	std::function<void (WFNetworkTask<REQ, RESP> *)> process;
};

template<class REQ, class RESP>
CommSession *WFServer<REQ, RESP>::new_session(long long seq, CommConnection *conn) {
	using factory = WFNetworkTaskFactory<REQ, RESP>;
	WFNetworkTask<REQ, RESP> *task;

	task = factory::create_server_task(this, this->process);
	task->set_keep_alive(this->params.keep_alive_timeout);
	task->set_receive_timeout(this->params.receive_timeout);
	task->get_req()->set_size_limit(this->params.request_size_limit);

	return task;
}
```

（PS，代码量很少，读者表示狂喜。）

如代码所写的那样，WFServer就是继承了一下WFServerBase，并重写了new_session函数。究其根本这里的new_session实际上重写的是CommService当中所定义的纯虚函数。如果你认为应该仔细去阅读这里重写的虚函数，那你就错了，实际上WFHttpServer**又将new_session函数进行全特化实现**。所以WFServer的new_session看看就好。无需深入理解。

WFServer重点就是将示例在创建server时传入的process回调，保存到了成员变量当中，**以供new_session时将任务回调传给Task**。下面重点研究一下WFServerBase。

从上面的分析了解到WFServerBase继承自CommService。WFServerBase实现如下：

```cpp
class WFServerBase : protected CommService {
public:
	WFServerBase(const struct WFServerParams *params) :
		conn_count(0) {
		this->params = *params;
		this->unbind_finish = false;
		this->listen_fd = -1;
	}

public:
	/* To start a TCP server */
	/* ... */
	/* Start with binding address. The only necessary start function. */
	int start(const struct sockaddr *bind_addr, socklen_t addrlen);

	/* stop() is a blocking operation. */
	void stop() {
		this->shutdown();
		this->wait_finish();
	}

	/* Nonblocking terminating the server. For stopping multiple servers.
	 * Typically, call shutdown() and then wait_finish().
	 * But indeed wait_finish() can be called before shutdown(), even before
	 * start() in another thread. */
	void shutdown();
	void wait_finish();

public:
	size_t get_conn_count() const { return this->conn_count; }

protected:
	WFServerParams params;

protected:
	virtual int create_listen_fd();
	virtual WFConnection *new_connection(int accept_fd);
	void delete_connection(WFConnection *conn);

private:
	int init(const struct sockaddr *bind_addr, socklen_t addrlen);
	virtual void handle_unbound();

protected:
	std::atomic<size_t> conn_count;

private:
	int listen_fd;
	bool unbind_finish;

	std::mutex mutex;
	std::condition_variable cond;

	class CommScheduler *scheduler;
};
```

首先，我们看到WFServerBase当中有一个类型为CommScheduler的成员变量scheduler。我们应该感到惊喜，因为CommScheduler不就是对Communicator做了一层浅浅的封装吗？这里出现的scheduler不就意味着WFServerBase和Communicator联系起来了吗？那server的启动必定是调用了Communicator::bind接口来创建、绑定、监听listen socket。下面重点研究一下start函数的函数的实现：

```cpp
int WFServerBase::start(const struct sockaddr *bind_addr, socklen_t addrlen) {
	if (this->init(bind_addr, addrlen) >= 0) {
		if (this->scheduler->bind(this) >= 0)
			return 0;

		this->deinit();
	}

	this->listen_fd = -1;
	return -1;
}
```

init函数伪代码如下：

```cpp
int WFServerBase::init(const struct sockaddr *bind_addr, socklen_t addrlen) {
	/* ... */
	if (this->CommService::init(bind_addr, addrlen, -1, timeout) < 0)	// 调用基类CommService的初始化函数，就是将listen fd所绑定的地址拷贝一份到基类。
		return -1;

	this->scheduler = WFGlobal::get_scheduler();						// 全局的单例CommScheduler对象。
	return 0;
}
```

主要干了两件事：调用基类的init，将绑定的地址拷贝一份到基类的成员变量当中。然后通过__CommManager获取全局的单例CommScheduler对象。

特别的是，**这里有个重要的时间点**，在__CommManager被构造时，会**初始化CommScheduler对象**，如果你看过上一篇博客，你一定知道为什么这个时刻重要。因为CommScheduler::init函数会**启动workflow底层的事件池和状态迁移池**。具体的架构模型图可以参考：[WorkFlow源码剖析——Communicator之TCPServer（中）](https://blog.csdn.net/m0_52566365/article/details/143493066)。

在WFServerBase::start实现中，调用init函数过后，立马调用CommScheduler::bind（实际上就是Communicator::bind），该函数里面会做网络编程三部曲：创建、绑定、监听。至此我们的TCPServer服务器就在这里启动，等待客户端的连接。

关于WFServerBase其实还有两个有趣的知识点：new_connection 和 服务停止。

- new_connection：该函数和WFServerBase::conn_count强相关。new_connection所创建的对象共用WFServerBase::conn_count。每当有客户端连接到来，都会创建一个CommConnection对象，同时会使WFServerBase::conn_count自增一。每当连接断开，Communicator当中就会调用__release_conn释放连接上下文，并且CommConnection对象也随之释放，其构造函数当中，会将WFServerBase::conn_count变量自减一。所以说，每次在连接到来创建的CommConnection对象可以视为连接计数器。（PS，因为目前只了解workflow的部分源码，所以连接计数器存在的具体意义，我目前还未能领悟。后面有时间的话，再去深究吧。）

- 服务停止：如代码注释那样，WFServerBase所提供的stop接口是阻塞的，它其实连续调用了两个函数：shutdown、wait_finish。其中shutdown会调用Communicator::unbind函数，它会直接将listen fd从mpoller当中删除。当调用shutdown函数时，整体**停止的链路是这样的**：

```
WFServerBase::shutdown -> 

CommScheduler::unbind -> 

Communicator::unbind -> 

mpoller_del(listen_fd) - - -> 

Communicator::handle_listen_result -> 

Communicator::shutdown_service -> 

while (直到CommService的ref减为0) { CommService::decref() } -> 

WFServerBase::handle_unbound
```

Communicator::shutdown_service代码如下：

```cpp
void Communicator::shutdown_service(CommService *service) {
	close(service->listen_fd);
	service->listen_fd = -1;
	service->drain(-1);
	service->decref();
}
```

这里的service->drain(-1)会将server端目前所有的连接都从mpoller当中移除。然后等待所有连接上下文回调CommServiceTarget::decref将server对象的引用计数减为0后，调用WFServerBase::handle_unbound函数

```cpp
inline void CommService::decref() {
	if (__sync_sub_and_fetch(&this->ref, 1) == 0)
		this->handle_unbound();						// 最终被重写成：WFServerBase::handle_unbound
}
```

WFServerBase::stop的注释说明了该函数是阻塞的，其阻塞主要原因就在wait_finish，它会等待所有的连接被释放然后释放WFServerBase的引用计数后才会跳出等待条件变量的循环。

```cpp
void WFServerBase::handle_unbound() {
	this->mutex.lock();
	this->unbind_finish = true;
	this->cond.notify_one();
	this->mutex.unlock();
}

void WFServerBase::wait_finish() {
	std::unique_lock<std::mutex> lock(this->mutex);

	while (!this->unbind_finish)
		this->cond.wait(lock);

	this->deinit();
	this->unbind_finish = false;
	lock.unlock();
}
```

### 探究WFHttpServerTask

好了，tcpserver的启动流程基本流程已经分析完毕，下面我们重点看看WFHttpServer::new_session的实现。该函数在每轮读取客户端请求时会被调用一次。返回值是类型为CommSession的对象。

```cpp
template<> inline
CommSession *WFHttpServer::new_session(long long seq, CommConnection *conn) {
	WFHttpTask *task;

	task = WFServerTaskFactory::create_http_task(this, this->process);
	task->set_keep_alive(this->params.keep_alive_timeout);
	task->set_receive_timeout(this->params.receive_timeout);
	task->get_req()->set_size_limit(this->params.request_size_limit);

	return task;
}
```

可以看到出现了一个新的类——WFHttpTask，我可以明确告诉你，WFHttpTask只是一个基类，我们应该从final类开始深入分析。

对于WFHttpTask，它的定义如下：

```cpp
using WFHttpTask = WFNetworkTask<protocol::HttpRequest,
								 protocol::HttpResponse>;
```

那么WFNetworkTask是啥呢？先别急，后面再来揭晓它的源码。通过WFServerTaskFactory::create_http_task我们可以找到我们所需要的final类——WFHttpServerTask它的定义如下：

```cpp
class WFHttpServerTask : public WFServerTask<protocol::HttpRequest,
											 protocol::HttpResponse> {
private:
	using TASK = WFNetworkTask<protocol::HttpRequest, protocol::HttpResponse>;

public:
	WFHttpServerTask(CommService *service, std::function<void (TASK *)>& proc) :
		WFServerTask(service, WFGlobal::get_scheduler(), proc),
		req_is_alive_(false),
		req_has_keep_alive_header_(false) {  }

protected:
	virtual void handle(int state, int error);
	virtual CommMessageOut *message_out();

protected:
	bool req_is_alive_;
	bool req_has_keep_alive_header_;
	std::string req_keep_alive_;
};
```

从构造函数当可以看到，再一次对全局单例的CommScheduler的引用。类的成员函数包括hanlde、message_out最终实现，我们重点关注handle的实现：

```cpp
void WFHttpServerTask::handle(int state, int error) {
	if (state == WFT_STATE_TOREPLY) {
		/* 设置fianl类的成员变量... */
	}

	this->WFServerTask::handle(state, error);
}

```

在服务端收完并解析完客户端发来的请求报文之后（在Communicator::handle_incoming_request函数当中）会进入该函数，从WFT_STATE_TOREPLY宏的命名也可以推测到，它代表准备回复的状态。在做完final类一些设置后，最终会调用父类的handle，所以下面深入看看WFServerTask模板类的实现。

**tcpserver任务部分最烧脑的就在WFServerTask模板类的实现**，对于WFNetworkTask模板类，它本身的成员函数对我们理解tcpserver本身来说并不重要。但需要注意的是WFNetworkTask继承自CommRequest。

简单用字符画了一下WFHttpServerTask的继承树。如下：

```
	SubTask		CommSession
			\/
		CommRequest
			|
			V
	WFNetworkTask<REQ, RESP>	# 该类的实现在对我们理解tcpserver不是特别重要，读者可以跳过该类。
			|
			V
	WFServerTask<REQ, RESP>
			|
			V
	WFHttpServerTask
```

在正式讲解WFServerTask前，**先学习几个关键知识点：**

首先回顾一下，SubTask::subtask_done函数实现：

```cpp
void SubTask::subtask_done() {
	SubTask *cur = this;

	cur = cur->done();
	if (cur) {
		cur->dispatch();		// 下一个任务的dispatch
	}
	return;
}
```

更简单点描述，调done后调dispatch触发任务队列的下一个任务。**（关键点一：）其中done函数实现最后都会调用`series_of(this)->pop()`，这行代码是获取SeriesWork串行队列的下一个任务，当队列中（没有任何任务了）山穷水尽了会返回nullptr，并且SeriesWork会delete this（SeriesWork对象本身）。**

然后了解一下两个WFServerTask当中的内嵌类的定义：

```cpp
class Processor : public SubTask {
public:
	Processor(WFServerTask<REQ, RESP> *task,
				std::function<void (WFNetworkTask<REQ, RESP> *)>& proc) :
		process(proc) {
		this->task = task;
	}

	virtual void dispatch() {
		this->process(this->task);		// 调用
		this->task = NULL;	/* As a flag. get_conneciton() disabled. */
		this->subtask_done();
	}

	virtual SubTask *done() {
		return series_of(this)->pop();	// 获取串行队列下一个任务
	}

	std::function<void (WFNetworkTask<REQ, RESP> *)>& process;
	WFServerTask<REQ, RESP> *task;
} processor;

class Series : public SeriesWork {
public:
	Series(WFServerTask<REQ, RESP> *task) :
		SeriesWork(&task->processor, nullptr) {
		this->set_last_task(task);
		this->task = task;
	}

	virtual ~Series() {
		delete this->task;
	}

	WFServerTask<REQ, RESP> *task;
};
```

- Processor::dispatch函数首先调用了一下构造传进来的回调函数process，然后调用subtask_done，结合上面的分析，它会调用串行队列当中的下一个任务的dispatch函数。

- 对于Series，只有析构和构造函数，从构造函数当中可以看出来，它本质上就是 **（关键点二）只有两个任务的串行队列。并且在该串行队列被delete时，顺带会在析构函数当中delete掉二号任务。**此外，**（关键点三）在每个任务被加到串行队列当中时，会将任务的SubTask::pointer指针指向串行队列对象。**

好了，下面从WFServerTask<REQ, RESP>::handle函数开始分析其中的奥妙。源代码如下：

```cpp
template<class REQ, class RESP>
void WFServerTask<REQ, RESP>::handle(int state, int error) {
	if (state == WFT_STATE_TOREPLY) {
		this->state = WFT_STATE_TOREPLY;
		this->target = this->get_target();
		new Series(this);
		this->processor.dispatch();
	}
	else if (this->state == WFT_STATE_TOREPLY) {
		this->state = state;
		this->error = error;
		if (error == ETIMEDOUT)
			this->timeout_reason = TOR_TRANSMIT_TIMEOUT;

		this->subtask_done();
	}
	else
		delete this;
}
```

因为WFServerTask顶层的基类包括：SubTask + **CommSession**，对这里着重强调CommSession，因为CommSession当中的handle最终被重写成如上所示的代码。服务端在每次读完（并解析完）客户端发来的数据后，状态迁移池都会回调Communicator::handle_incoming_request函数，在每次写完客户端请求的回复后，状态迁移池都会回调Communicator::handle_reply_result函数。这两函数当最后都会调用session->handle，所不同的是每次传入的state参数有所不同。**正常情况下，在读完后回调session->handle传入的state为CS_STATE_TOREPLY，而在写完后回调的session->handle传入的state为CS_STATE_SUCCESS。**

- 所以在解析完客户端请求后所调用的handle会进入第一个if分支，从代码当中可以看到，它先是将WFServerTask::state数据成员设置成了WFT_STATE_TOREPLY，这为发送完回复再次回到handle进入第二个if分支做准备。然后最关键的是`new Series(this);`这行代码，如果你第一次看workflow的源码这样的写法一定会让你蒙。**什么鬼？new的成员没用什么变量去接？这不典型内存泄漏了吗？**，但是深入研究下去，这样写好像也没问题。结合上面Series的定义，所以最终new的Series串行队列当中第一个任务是WFServerTask::processor，第二个任务是WFServerTask本身。继续分析第一个if分支的代码，接下来调用了`this->processor.dispatch();`函数这也是整个业务代码的起始点。深入分析Processor::dispatch实现可知，它首先调用process回调，我可以直接告诉你此回调正是我们在示例当中创建server时传进来的process函数。在调用process处理完业务代码，然后调用了`this->subtask_done();`函数，根据前面提到的**关键点一**，我们可以知道这将返回串行队列的第二个任务即WFServerTask。我想这里一定会有读者有疑惑，怎么就返回第二个任务了？不是应该返回第一个任务吗？如果你有这样的疑惑，我建议你仔细阅读一下SeriesWork这部分的源码，所谓的两个任务实际上首个任务是不会入队列的，需要人手动触发，而在WFServerTask<REQ, RESP>::handle当中其实已经手动触发了一号任务————Processor，所以第一次调用subtask_done实际上返回的是第二个任务。好了回到正题，进入二号任务的dispatch（`WFServerTask::dispatch`），因为我们在前面已经将WFServerTask::state设置成了WFT_STATE_TOREPLY所以，进入if分支，这里应该开个香槟了，因为这里调用了`this->scheduler->reply`，这意味着服务端向客户端发送回复了！！！正常情况下会返回大于零的值，然后直接返回。这里罗列一下调用和返回流程：

	首先是调用流程：

	```
	WFServerTask<REQ, RESP>::handle ->
	Processor::dispatch -> 
	Processor::subtask_done -> 
	WFServerTask::dispatch
	```

	然后是返回流程：
	
	```
	从第二个任务的WFServerTask的：dispatch函数当中 返回到 -> 
	第一个任务Processor的基类函数：subtask_done -> 
	返回到第一个任务Processor的dispatch函数 -> 
	返回到WFServerTask<REQ, RESP>::handle函数。
	```

	我这里想表达的是：**WFServerTask<REQ, RESP>::handle第一个if分支的一次dispatch实际上嵌套执行了两个任务。**，注意是**嵌套**，这点很重要！

- 然后在写完回复后，会再次回到WFServerTask<REQ, RESP>::handle，此时会进入第二个if分支，并且根据**关键点一**，**因为此时第一个if分支new的串行队列已经为空，所以WFServerTask::subtask_done操作会将第一个if分支new的串行队列给释放掉，同时因为Series的释放，它的析构函数又会将WFServerTask给释放掉！**

下面贴出WFServerTask关键的代码：

```cpp
template<class REQ, class RESP>
class WFServerTask : public WFNetworkTask<REQ, RESP> {
protected:
	virtual CommMessageOut *message_out() { return &this->resp; }
	virtual CommMessageIn *message_in() { return &this->req; }
	virtual void handle(int state, int error);

protected:
	virtual void dispatch() {
		if (this->state == WFT_STATE_TOREPLY) {
			/* Enable get_connection() again if the reply() call is success. */
			this->processor.task = this;
			if (this->scheduler->reply(this) >= 0)	// 发生回复
				return;

			this->state = WFT_STATE_SYS_ERROR;
			this->error = errno;
			this->processor.task = NULL;
		}
		else
			this->scheduler->shutdown(this);

		this->subtask_done();
	}

	virtual SubTask *done() {
		SeriesWork *series = series_of(this);

		if (this->callback)
			this->callback(this);

		/* Defer deleting the task. */
		return series->pop();
	}

public:
	WFServerTask(CommService *service, CommScheduler *scheduler,
				 std::function<void (WFNetworkTask<REQ, RESP> *)>& proc) :
		WFNetworkTask<REQ, RESP>(NULL, scheduler, nullptr),
		processor(this, proc)
	{ }
};
```

好了基本的HTTPServer端处理客户端请求的流程已经梳理完毕，最后贴出我在看源码的过程当中，所梳理流程笔记，可以给读者提供一些思路。同时也作为我个人的备忘笔记：

```
# Workflow服务端处理连接流程分析

server:

    entry: 
        accept_conn: CONN_STATE_CONNECTED -> 
            create_request: CONN_STATE_RECEIVING ->                             // tag1
                append_message: 当http请求接受完毕时：CONN_STATE_SUCCESS ->
                    handle_incoming_request: 
                        ==>     CONN_STATE_IDLE && entry被追加到target->idle_list上;
                        ==>    session->passive = 2;
                        ==>    state = CS_STATE_TOREPLY

    |   |   |
    V   V   V
    WFHttpServerTask::handle ->
        WFServerTask<REQ, RESP>::handle ->
            ```cpp
                template<class REQ, class RESP>
                void WFServerTask<REQ, RESP>::handle(int state, int error)
                {
                    if (state == WFT_STATE_TOREPLY)         // √
                    {
                        this->state = WFT_STATE_TOREPLY;
                        this->target = this->get_target();
                        new Series(this);
                        this->processor.dispatch();
                    }
                    else if (this->state == WFT_STATE_TOREPLY)
                    {
                        this->state = state;
                        this->error = error;
                        if (error == ETIMEDOUT)
                            this->timeout_reason = TOR_TRANSMIT_TIMEOUT;

                        this->subtask_done();
                    }
                    else
                        delete this;
                }
            ```

        WFServerTask<REQ, RESP>::dispatch ->
            this->scheduler->reply(this) -> 以写方式将entry添加到epoll上
                session->passive = 3;

    |   |   |       
    V   V   V
    handle_reply_result ->
        ===> entry->state = CONN_STATE_KEEPALIVE && entry 被追加到service->alive_list && 以读方式将entry添加到epoll上（如果保活的话）
        ===> state = CS_STATE_SUCCESS

    |   |   |
    V   V   V
    WFHttpServerTask::handle ->
        WFServerTask<REQ, RESP>::handle ->
            ```cpp
                template<class REQ, class RESP>
                void WFServerTask<REQ, RESP>::handle(int state, int error)
                {
                    if (state == WFT_STATE_TOREPLY)
                    {
                        this->state = WFT_STATE_TOREPLY;
                        this->target = this->get_target();
                        new Series(this);
                        this->processor.dispatch();
                    }
                    else if (this->state == WFT_STATE_TOREPLY)  // √
                    {
                        this->state = state;
                        this->error = error;
                        if (error == ETIMEDOUT)
                            this->timeout_reason = TOR_TRANSMIT_TIMEOUT;

                        this->subtask_done();       // will delete Series for first 'if' branch malloc
                    }
                    else
                        delete this;
                }
            ```

    |   |   |
    V   V   V
    go to tag1.
```

---

**本章完结**