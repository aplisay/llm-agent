// A stand-in text driver for chat-session tests: no provider, deterministic
// replies, and the same conversation export/import contract the real drivers
// implement (lib/models/llm.js), so a session can be carried between processes
// and the test can see exactly what history the new process received.
export class FakeChatLlm {
  constructor({ tag = 'fake' } = {}) {
    this.tag = tag;
    this.messages = [];
    this.closed = false;
    // Number of messages taken from an imported conversation, or null when
    // this instance started fresh.
    this.imported = null;
  }

  async rawCompletion(input) {
    if (input) this.messages.push({ role: 'user', content: input });
    const n = this.messages.filter((m) => m.role === 'assistant').length + 1;
    const text = `${this.tag} reply ${n} to: ${String(input ?? '').slice(0, 60)}`;
    this.messages.push({ role: 'assistant', content: text });
    // No usage: keeps the metering path out of these tests.
    return { text, calls: [] };
  }

  async callResult(results) {
    this.messages.push({ role: 'user', content: results });
    return this.rawCompletion(null);
  }

  exportConversation() {
    return { driver: 'fake', messages: this.messages };
  }

  importConversation(conversation) {
    if (conversation?.driver !== 'fake' || !Array.isArray(conversation.messages)) return false;
    this.messages = conversation.messages;
    this.imported = conversation.messages.length;
    return true;
  }

  abandonTurn() {}

  async close() {
    this.closed = true;
  }
}

export default FakeChatLlm;
