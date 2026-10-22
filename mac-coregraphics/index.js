const path = require('path');
const binding = path.join(__dirname, 'build', 'Release', 'mac-coregraphics.node');
try {
  module.exports = require(binding);
} catch (e) {
  // Fallback: try from prebuild location
  module.exports = require(path.join(__dirname, 'prebuilds', 'mac-coregraphics.node'));
}
