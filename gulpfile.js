const gulp = require('gulp');
const exec = require('gulp-exec');
const replace = require('gulp-replace');
const rename = require("gulp-rename");
const execSync = require('child_process')
  .execSync;

var paths = {
  libs: ['lib/**/*.js', 'handlers/**/*.js'],
};

gulp.task('watch', function () {

  gulp.watch(paths.libs, gulp.series(['docs']));

  
});

gulp.task('docs', function () {
  const fs = require('fs-then-native')
  const jsdoc2md = require('jsdoc-to-markdown');
  
  return jsdoc2md.render({
      files: paths.libs,
      configure: 'jsdoc.json'
    })
    .then(output => fs.writeFile('API.md', output))
});

// The default task (called when you run `gulp` from cli)
gulp.task('default', gulp.parallel(['docs', 'watch']));
