const path = require('path');
const binding = path.join(__dirname, 'build', 'Release', 'win-input.node');
try {
  module.exports = require(binding);
} catch (e) {
  // Fallback: try from prebuild location
  module.exports = require(path.join(__dirname, 'prebuilds', 'win-input.node'));
}
