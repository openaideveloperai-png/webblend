// Undo / redo stack. Each entry is {label, undo(), redo()}.

export class History {
  constructor(app, limit = 80) {
    this.app = app;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
  }
  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this.app.emit('history');
  }
  undo() {
    const e = this.undoStack.pop();
    if (!e) return false;
    try { e.undo(); } catch (err) { console.error(err); }
    this.redoStack.push(e);
    this.app.emit('history');
    this.app.toast?.(`Undo: ${e.label}`, 'info', 1200);
    return true;
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    try { e.redo(); } catch (err) { console.error(err); }
    this.undoStack.push(e);
    this.app.emit('history');
    this.app.toast?.(`Redo: ${e.label}`, 'info', 1200);
    return true;
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this.app.emit('history'); }
}
