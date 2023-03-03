class BufferHandler {
  constructor(dataFn) {
    this.dataFn = dataFn;
    this.buffer = '';
  }
  
  pump(chunk) {
    // Written by ChatGPT
    let buffer = this.buffer;
    buffer += chunk.toString('utf8');
    const parts = buffer.split('\n');
    this.buffer = parts.pop();
    parts.forEach(part => {
      try {
        const jsonObject = JSON.parse(part);
        this.dataFn(jsonObject);
      } catch (err) {
        console.error(err);
      }
    });
  }
}

module.exports = BufferHandler;