/**
 * Superclass for an Llm interface: generic constructor, completion and hint parsing
 *
 * @class Llm
 */
class Llm {

  /**
   *
   * 
   * @param {Object} logger Pino logger instance
   * @param {string} user a unique user ID
   * @param {string} prompt The initial (system) chat prompt
   * @param {Object} options options
   * @param {number} options.temperature The LLM temperature
   *                 See model documentation
   * @memberof Llm
   */
  constructor(logger, user, prompt, options) {
    Object.assign(this, {
      options,
      initialPrompt: prompt,
      prompt,
      user,
      logger: logger.child({ user }),
    });
    this.logger.info({ init: this, prompt }, 'client created');
  }

/**
 * @typedef {Object} Completion
 * @property {string} text parsed text string with \n's translated to breaks and directives removed
 * @property {Object} data returned inline data object (or null of no returned data)
 * @property {boolean} hangup true if a @HANGUP inline directive is present in the raw completion
 */

  /**
   * Parse a raw completion, return speech text, data and hangup signal
   *
   * @param {string} input raw completion
   * @return {Completion} completion parsed completion
   * @memberof Llm
   */
  async completion(input) {
    let rawText = await this.rawCompletion(input);
    let directives = Array.from(rawText.matchAll(/([^@]*)@(DATA|HANGUP)(:\s*)?([^\n]*)?/g));
    let opts = {};

    if (directives.length) {
      opts = directives.reduce((o, d) => {
        let data;
        this.logger.info({ o, d });
        o.text = o.text + d[1];
        if (d[4]) {
          this.logger.info({ d4: d[4] }, 'Parsing JSON');
          try {
            data = JSON.parse(d[4]);
          }
          catch (e) {

            data = d[4];
            this.logger.error({ data, e }, 'JSON parse error');
          }
        }
        let opt = (d[2] && { [d[2].toLowerCase()]: (data || true) }) || {};
        return { ...o, ...opt };
      }, { text: '' });
    }
    opts.text = `${opts.text || rawText}`
      .replace(/\n\n/g, '<break strength="strong" />')
      .replace(/\n/g, '<break strength="medium" />');
    return opts;

  }


  /**
   * A list of all the unique words in the initial prompt.
   * Useful as hints for STT context priming.
   *
   * @readonly
   * @memberof Llm
   */
  get voiceHints() {
    let hints = this._hints || [...new Set(this.initialPrompt.split(/[^a-zA-Z0-9]/))].filter(h => h.length > 2);
    return (this._hints = hints);
  }
}

module.exports = Llm;
