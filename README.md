# @csobj/heft-babel-plugin

> This plugin will transpile source files only project owned, Files in node_modules not supported.

## Quick Setup

```json
/**
 * [config/babel.json]
 * Following json object describe configuration schema for this plugin and default value.
 */
{
    "$schema": "../node_modules/@csobj/heft-babel-plugin/lib/schemas/heft-babel-plugin.schema.json",
    "srcFolder": "src/",
    "outFolder": "lib/",
    // Files with those extensions are treat as source file.
    "fileExtensions": [
        ".js",
        ".ts"
    ],
    // File extension of generated code.
    "outputFileExtension": ".js",
    // The plugin will transform source codes as commonjs for tests.
    // It use @babel/plugin-transform-modules-commonjs internally.
    "emitFolderNameForTests": "lib-commonjs"
}
```

```js
/* babel.config.cjs */
module.exports = (api) => {
    // This will block configuration file cached on @babel/core during watch mode
    api.cache(false);
  
    // It is sample configuration. You can use your own babel configuration also.
    // Just don't forget to setup dependencies on package.json of your project.
    return {
      presets: ['@babel/preset-typescript'],
      sourceMaps: 'both'
    };
};
```
