import {client as clientPlugins} from 'pluginsConfig';

function importer () {
  let context,
    importedFiles;

  function buildContext() {

    /**
     *  buildContext creates the context for the plugins
     *  require.context(<path>, true, <regexp>
     *    path: The path where the importer builds the context. 'plugins' is allowed as path because it's an alias
     *    regxp: A Regular Expression to match the files that the importer needs. i.e (index.js, config.json)
     *  data such as path and regexp cannot be passed as arguments or variables
     */
    context = require.context('plugins', true, /\.\/(.*)\/client\/(index|config).(js|json)$/);
    return importedFiles = context
      .keys()
      .map(key => shapeData(key));
  }

  function shapeData(test) {

    /**
     *  shapeData shapes each item in the plugins array with useful data
     *  returns an Object with the name of the plugin, the format, and it's key(filename)
     */
    const match = test.match(/\.\/(.*)\/client\/.*.(json|js)$/);
    return {
      name: match[1],
      format: match[2],
      key: match[0]
    };
  }

  function getConfig (name) {

    /**
     *  getConfig finds a the config file for each plugin
     *  returns the config.json as an object to be passed as props to the plugin
     */
    return importedFiles
      .filter(key => key.format === 'json' && key.name === name)
      .reduce((acc, plugin) => {
        return context(plugin.key);
      }, {});
  }

  function filterByUserConfig (list) {

    /**
     *  filterByUserConfig will filter the imported files and will only keep the allowed plugins
     */
    return list
      .filter(plugin => clientPlugins.indexOf(plugin.name) > -1);
  }

  function init() {

    /**
     *  init will build the context and
     *  returns a map with each plugin and its instance
     */
    buildContext();

    return filterByUserConfig(importedFiles)
      .filter(key => key.format === 'js')
      .reduce((entry, plugin) => {
        entry[plugin.name] = () => context(plugin.key)(getConfig(plugin.name));
        return entry;
      }, {});
  }

  return init();
}

export default importer();
