class BufferHandler {
  raw = '';

  constructor(handlerFn) {
    this.handlerFn = handlerFn;
  }

  pump(chunk) {
    this.raw += chunk.toString();
    var pos;
    while ((pos = this.raw.indexOf('\n')) >= 0) {
      if (pos == 0) {
        this.raw = raw.slice(1);
        continue;
      }
      this.processLine(pos);
      this.raw = this.raw.slice(pos + 1);
    }
  }

  processLine(pos) {
    var line = this.raw.slice(0, pos);
    if (line.length > 0) {
      var data = JSON.parse(line);
      this.handlerFn(data);
    }
  }
}

module.exports = BufferHandler;