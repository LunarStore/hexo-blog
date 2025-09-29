---
title: WorkFlow GO-Task 源码分析
date: 2024-10-13 12:00:00
tags:
  - 高性能服务器框架
---

[WorkFlow GO-Task 源码分析](https://blog.csdn.net/m0_52566365/article/details/142903964)

[WorkFlow源码剖析——Communicator之TCPServer（上）](https://blog.csdn.net/m0_52566365/article/details/143452443)

[WorkFlow源码剖析——Communicator之TCPServer（中）](https://blog.csdn.net/m0_52566365/article/details/143493066)

[WorkFlow源码剖析——Communicator之TCPServer（下）](https://blog.csdn.net/m0_52566365/article/details/143605123)

## 前言

任何好的框架的设计都是围绕着一个核心思想去展开，sylar的一切皆协程、muduo的one loop per thread等。一切皆是任务流就是workflow的精髓。（PS，目前作者功力尚浅，许多设计细节还未能悟透其用意，目前也只能尽力将我的理解呈现出来，有错误非常欢迎指出。

也是尝试着阅读过许多开源优秀的代码，这里记录一下我个人在阅读一份源码时的习惯：**适可而止的自低向上**。因为我在阅读一份完全不了解的源码时，迫不及待的想去知道每个每个模块、每个函数的实现细节，我也曾尝试以自顶向下去阅读一份源码，但是无法克制自己钻牛角尖的心，并且在经验尚浅，完全不了解设计背景的境况下，自顶向下去阅读一份源码，某一个函数的实现你只能去猜，由于经验尚浅，你大概率猜的也是错误的。所以，兜兜转转，我还是遵循我个人的习惯，自低向上去阅读一份源码。当然，应该：**适可而止的自低向上**，一些你完全知道起什么作用的模块其实就不必去深究了，比如：链表、红黑树、编码器等。深入细节的同时，也不要忘了我们的初心：框架的设计思想。

<!-- more -->

网络框架（包括库）的模块设计其实有很多相似的地方，比如都会有的：线程池、对epoll的封装、对io接口的封装、对tcpserver以及tcpclient的封装等。在阅读网络并发相关的源码时可以以这些方面入手。

在深入阅读workflow的源码之后，特别是在kernel文件夹下对一些基础模块的封装中感受到了对c++的克制使用。因为kernel下基础模块的实现大多都是以c语言为主。这点大家要有一个心理准备。

这里建议读者在阅读workflow，go-task源码时，以如下顺序阅读：

ExecQueue -> ExecSession -> Executor-> ExecRequest -> SubTask -> __ExecManager -> __WFGoTask -> WFGoTask -> SeriesWork

## 正文

下面直接以workflow给的gotask的示例作为本文的切入点：

### 用法

go-task的用法示例如下：

```cpp
#include <stdio.h>
#include <utility>
#include "workflow/WFTaskFactory.h"
#include "workflow/WFFacilities.h"

void add(int a, int b, int& res) {
    res = a + b;
}

int main(void) {
    WFFacilities::WaitGroup wait_group(1);
    int a = 1;
    int b = 1;
    int res;

    WFGoTask *task = WFTaskFactory::create_go_task("test", add, a, b, std::ref(res));   // cb1
    task->set_callback([&](WFGoTask *task) {    // cb2
        printf("%d + %d = %d\n", a, b, res);
        wait_group.done();
    });
 
    task->start();
    wait_group.wait();
    return 0;
}
```

如果你有一定网络编程的基础，应该很容易看懂这段小daemo。我们可以这段代码猜测：

第一行声明了一个WaitGroup变量，从后面的代码可以知道wait_group的作用是：阻塞主线程等待计算完成。在创建wait_group后，将计算过程add函数封装在一个回调函数（cb1）当中，cb1作为一个参数再来构造一个任务--WFGoTask，然后调用WFGoTask::set_callback函数又设置了一个回调函数（cb2），从代码上可以看到，该cb2的作用是：打印计算结果并通知主线程计算完毕。

所以经过上面的分析，我们可以知道：

1. WaitGroup的实现一定是基于条件变量/信号量。

2. 作为WFGoTask构造参数cb1，一定某一时刻被线程池里面的某个线程给调用了，并且该线程在调用add函数返回之后，一定是**直接或者间接**调用了一下cb2。

### 源码简析

示例代码中create_go_task的第一个参数其实是kernel目录下的ExecQueue队列对应的队列名。ExecQueue具体的用法以及作用稍后讲解，只需知道它是一个队列即可。

create_go_task实现很简单，它里面就是依赖一个全局的单例__ExecManager，通过这个单例拿到队列名对应的队列指针以及Executor对象。然后将队列和Executor对象作为__WFGoTask的构造参数，创建出了继承自WFGoTask的__WFGoTask对象。

这里备注一下：__ExecManager单例管理从队列名到队列指针的映射。并且在__ExecManager初始化时，会创建一个Executor对象。

目前为止，出现了几个新的类：ExecQueue、Executor、__WFGoTask。

对于ExecQueue从kernel目录下可以看到它的源码，单纯就是一个链表，使用的还是linux原生链表。它的每一个节点都是ExecSessionEntry类型，如下定义：

```cpp
struct ExecSessionEntry {
	struct list_head list;
	ExecSession *session;
	thrdpool_t *thrdpool;
};
```

单独看ExecQueue、ExecSession、ExecSessionEntry的源码一定会蒙（我就是），所以这里直接讲解Executor的实现，前面的三个类就是被它所使用。

```cpp
void Executor::executor_thread_routine(void *context) {
	ExecQueue *queue = (ExecQueue *)context;
	struct ExecSessionEntry *entry;
	ExecSession *session;
	int empty;

	entry = list_entry(queue->session_list.next, struct ExecSessionEntry, list);
	pthread_mutex_lock(&queue->mutex);
	list_del(&entry->list);
	empty = list_empty(&queue->session_list);
	pthread_mutex_unlock(&queue->mutex);

	session = entry->session;
	if (!empty) {
		struct thrdpool_task task = {
			.routine	=	Executor::executor_thread_routine,
			.context	=	queue
		};
		__thrdpool_schedule(&task, entry, entry->thrdpool);
	}
	else
		free(entry);

	session->execute();
	session->handle(ES_STATE_FINISHED, 0);
}
```

流程如下：

1. 从队列中取ExecSessionEntry。

2. 队列非空的话，将ExecSessionEntry中的session包装成thrdpool_task，并且将ExecSessionEntry的地址复用成线程池的__thrdpool_task_entry（PS：线程池在拿到__thrdpool_task_entry时用完后会自动free掉）。

3. 队列为非空的话，直接free掉ExecSessionEntry。

4. 最后执行ExecSession的execute、handle。

这里的execute函数其实暗示着会调用cb1，handle其实就暗示里面会调用cb2。这下前后不就连起来了？（恍然大悟！）别着急，我们继续去剖析源码。

细心的读者应该会发现这句代码没被放在锁里面：

```cpp
entry = list_entry(queue->session_list.next, struct ExecSessionEntry, list);
```

为什么可以不放在锁里面？如果线程2，在线程1执行完list_del之前，拿到了同一个entry，这样不会有野指针的问题吗？

这里放出我的猜测：Executor::executor_thread_routine本身就已经保证了一个时刻只会有一个线程访问队列头部。这个函数的执行逻辑是这样的：当前Executor::executor_thread_routine的回调是靠上一个Executor::executor_thread_routine回调访问完链表头部之后触发的，**也即下一个队列头部访问的回调还得靠上一个回调来封装**。这里其实有点并行任务串行化的味道了。

```cpp
struct thrdpool_task task = {
    .routine	=	Executor::executor_thread_routine,
    .context	=	queue
};
__thrdpool_schedule(&task, entry, entry->thrdpool);
```

最后是ExecQueue队列的start点，如下：

```cpp
int Executor::request(ExecSession *session, ExecQueue *queue) {
	struct ExecSessionEntry *entry;

	session->queue = queue;
	entry = (struct ExecSessionEntry *)malloc(sizeof (struct ExecSessionEntry));
	if (entry) {
		entry->session = session;
		entry->thrdpool = this->thrdpool;
		pthread_mutex_lock(&queue->mutex);
		list_add_tail(&entry->list, &queue->session_list);
		if (queue->session_list.next == &entry->list) {
			struct thrdpool_task task = {
				.routine	=	Executor::executor_thread_routine,
				.context	=	queue
			};
			if (thrdpool_schedule(&task, this->thrdpool) < 0) {
				list_del(&entry->list);
				free(entry);
				entry = NULL;
			}
		}

		pthread_mutex_unlock(&queue->mutex);
	}

	return -!entry;
}
```

从源码中可以看到，就是使用malloc分配一块内存，将session封装成ExecSessionEntry，然后将其添加到队列尾部，如果队列原来为空（意味着ExecQueue没有开始执行），就启动第一个Executor::executor_thread_routine，这样它会**自动链式触发**执行队列当中的每一个任务的回调。

这里malloc分配的ExecSessionEntry由两个地方去释放：

1. **这里malloc分配的ExecSessionEntry会被复用为线程池的__thrdpool_task_entry，最后被线程池调用free释放掉。**

2. **在函数Executor::executor_thread_routine中，由ExecQueue最后一个任务调用free释放。**

从这里可以看到，workflow针对内存的释放也是极其晦涩（反正我在阅读源码时就是这样感觉）。为了性能，根本没使用智能指针，完全靠malloc和free。内存池也没有，这点我是无法理解的。

经过上面的分析我们了解了ExecSession、ExecQueue、Executor的作用，接下来我们分析一下，__WFGoTask是怎么使用这些类的。

从本段开头了解到ExecQueue、Executor是作为__WFGoTask的构造参数，所以下面我们以__WFGoTask为主去看看它是怎么实现的

```cpp
class __WFGoTask : public WFGoTask {
    // ...
protected:
	virtual void execute() {
		this->go();
	}

protected:
	std::function<void ()> go;

public:
	__WFGoTask(ExecQueue *queue, Executor *executor,
			   std::function<void ()>&& func) :
		WFGoTask(queue, executor),
		go(std::move(func)) { /* ... */ }
};
```

**使用了virtual关键字声明的execute函数！**，并且调用了go也即cb1！（衔接起来了！）

继续看它基类的实现：

```cpp
class WFGoTask : public ExecRequest {
public:
	void start() {
		assert(!series_of(this));
		Workflow::start_series_work(this, nullptr);
	}

public:
	void *user_data;

public:
	void set_callback(std::function<void (WFGoTask *)> cb) {
		this->callback = std::move(cb);
	}

protected:
	virtual SubTask *done() {
		SeriesWork *series = series_of(this);

		if (this->callback)
			this->callback(this);

		delete this;
		return series->pop();
	}

protected:
	std::function<void (WFGoTask *)> callback;

public:
	WFGoTask(ExecQueue *queue, Executor *executor) :
		ExecRequest(queue, executor) { /* ... */ }
};
```

WFGoTask::start()正是示例当中调用的start函数，set_callback正是设置的cb2回调。我可以明确的说，start_series_work会创建一个SeriesWork对象，并且将SeriesWork对象的指针赋值给WFGoTask祖父类SubTask的user_data成员，并且SeriesWork其实也是一个队列，它是串行队列，队列当中的任务是有先后执行顺序的。这里串行队列的设计是为特定的有先后依赖顺序的计算场景所设计的。

深入查看ExecRequest的实现：

```cpp
class ExecRequest : public SubTask, public ExecSession {
public:
	ExecRequest(ExecQueue *queue, Executor *executor) { /* ... */ }

public:
	virtual void dispatch() {
		if (this->executor->request(this, this->queue) < 0)
			this->handle(ES_STATE_ERROR, errno);
	}

protected:
	ExecQueue *queue;
	Executor *executor;

protected:
	virtual void handle(int state, int error) {
		this->state = state;
		this->error = error;
		this->subtask_done();
	}
};
```

SubTask类和ExecSession类非常简单，由于篇幅有限这只列出我们关心的函数。

SubTask有三个关键函数：

虚函数：dispatch、done

普通成员函数：subtask_done。

而

SubTask::dispatch 最终被重写为：ExecRequest::dispatch

SubTask::done 最终被重写为：WFGoTask::done

其中subtask_done实现如下：

```cpp
void SubTask::subtask_done() {
	SubTask *cur = this;

	while (1) {
		cur = cur->done();
		if (cur) {
			cur->dispatch();
		}
        /* ... */

		break;
	}
}
```

done的实现落实到了WFGoTask::done上，作用是销毁当前的task对象并且返回串行队列当中的下一个task，然后由subtask_done调用ExecRequest::dispatch将task挂到ExecQueue的链表上等待线程池的消费。

ExecSession有两个我们比较关心的纯虚函数：execute、handle。这两函数一路继承体系下来最终分别被重写为__WFGoTask::execute和ExecRequest::handle。

所以在Executor::executor_thread_routine函数中调用的execute、handle函数最终被重写为：__WFGoTask::execute、ExecRequest::handle()。

最后总结一下go-task执行的流程：

1. 构造一个go-task对象 && 调用start函数。

2. start函数会new一个first为go-task，last为nullptr的SeriesWork对象 && 调用first的dispatch也即ExecRequest::dispatch。

3. executor的request函数，将go-task挂到ExecQueue链表的尾部上，由线程池去消费。当然，如果ExecQueue原来是为空的，就创建第一个Executor::executor_thread_routine。

4. Executor::executor_thread_routine会**链式**触发让线程池处理ExecQueue每一个任务。

5. 调用任务的__WFGoTask::execute。

6. 调用任务的ExecRequest::handle。

7. 调用SubTask::subtask_done && （如果存在的话）调用SeriesWork对象的下一个task的dispatch（PS，可能不是ExecRequest::dispatch这个重载函数）

8. 调用WFGoTask::done。删除当前task对象并且返回串行队列的下一个串行任务。

**最后要还要提醒的一句是：Executor::executor_thread_routine在向ExecQueue的链表取任务时是保证非并发的，但是在执行任务的execute时，是有可能是并发执行的！** 有人可能会注意到那为什么在向链表取任务时要加锁？因为这把锁可能防止Executor::executor_thread_routine和Executor::request之间的竞争问题，而Executor::executor_thread_routine和Executor::executor_thread_routine之间并不存在竞争问题。

---

**本章完结**