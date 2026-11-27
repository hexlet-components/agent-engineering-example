require("tsx/cjs");
const { analyze } = require("./agent.ts");
const tickets = require("./data.json");
module.exports = class {
  constructor(options) {
    this.policy = options.config.policy;
  }
  id() {
    return this.policy;
  }
  async callApi(id) {
    const output = await analyze(
      { ticket: { id, version: 1, text: tickets[id] }, policy: this.policy, publish: false },
      "",
    );
    return { output };
  }
};
