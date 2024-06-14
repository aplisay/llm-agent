function escapeHtml(text) {
  return text.replace(/[&<>"']/g, function (match) {
    switch (match) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case '\'': return '&apos;';
    }
  });
};
/**
 * @param {string} raw text
 * @returns {string} SSML wrapped and escaped text
 *
 * @description Wrap input text in <speak> tag and Escape SSML special characters
 */
const ssml = function (text) {
  console.log({ text }, 'doing ssml markup');
  return (text && `<speak>${escapeHtml(text)}</speak>`);
};
const text = function (text) {
  console.log({ text }, 'doing text markup');
  return text;
};

module.exports = { ssml, text };