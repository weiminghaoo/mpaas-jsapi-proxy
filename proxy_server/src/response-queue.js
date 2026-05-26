class ResponseQueue {
  constructor() {
    this.queues = new Map(); // deviceId → Array of responses
    this.pendingRequests = new Map(); // deviceId → Array of resolve functions
  }

  // 推送响应到队列
  push(deviceId, response) {
    if (!this.queues.has(deviceId)) {
      this.queues.set(deviceId, []);
    }

    const queue = this.queues.get(deviceId);
    queue.push(response);

    // 如果有等待的轮询请求，立即响应
    if (this.pendingRequests.has(deviceId)) {
      const pending = this.pendingRequests.get(deviceId);
      if (pending.length > 0) {
        const resolve = pending.shift();
        resolve(this.dequeue(deviceId));
      }
    }
  }

  // 长轮询等待响应
  poll(deviceId, timeout = 30000) {
    return new Promise((resolve) => {
      // 检查是否已有响应
      if (this.hasResponse(deviceId)) {
        const response = this.dequeue(deviceId);
        resolve(response);
        return;
      }

      // 存储resolve函数，等待新响应
      if (!this.pendingRequests.has(deviceId)) {
        this.pendingRequests.set(deviceId, []);
      }

      const pending = this.pendingRequests.get(deviceId);
      pending.push(resolve);

      // 设置超时
      const timer = setTimeout(() => {
        // 从pending中移除
        const index = pending.indexOf(resolve);
        if (index > -1) {
          pending.splice(index, 1);
        }
        resolve(null); // 超时返回null
      }, timeout);

      // 清理定时器（如果被提前resolve）
      const originalResolve = resolve;
      resolve = (value) => {
        clearTimeout(timer);
        originalResolve(value);
      };
    });
  }

  // 检查是否有响应
  hasResponse(deviceId) {
    const queue = this.queues.get(deviceId);
    return queue && queue.length > 0;
  }

  // 从队列取出响应
  dequeue(deviceId) {
    const queue = this.queues.get(deviceId);
    if (queue && queue.length > 0) {
      return queue.shift();
    }
    return null;
  }

  // 清理设备队列
  clear(deviceId) {
    this.queues.delete(deviceId);
    this.pendingRequests.delete(deviceId);
  }

  // 获取队列状态
  getStatus() {
    const status = {};
    for (const [deviceId, queue] of this.queues) {
      status[deviceId] = {
        queueSize: queue.length,
        pendingRequests: this.pendingRequests.has(deviceId) 
          ? this.pendingRequests.get(deviceId).length 
          : 0
      };
    }
    return status;
  }
}

module.exports = { ResponseQueue };
