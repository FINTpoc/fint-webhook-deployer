# fint-webhook-deployer #

> Lightweight idle server listening for webhook posts and reacting accordingly

It will listen for http action on port 3009. When we receive webhook posts to this port, the following actions will be taken:
 
 * Stop and remove a docker container using the same name as this package, if it exists.
 * Pull down an updated image from the configured docker repo (defauts to hub.docker.com)
 * Create a new container with the image, and boot it. 


Expected webhook posts will be in this format:
```json
{
  "package": "my-package",
  "version": "1.2.1",
  "released": "ISO8601 (yyyy-MM-dd'T'HH:mm:ss.SSSZ)",
  "release_notes": "This is a test"
}
```

## USAGE ##

This will start the process as a daemon: 
```bash
npm start
```

In order to stop the process:
```bash
npm stop
```

## PREREQUISITES ##

The environment this server runs in, must have docker installed.

## Configuration ##

There's a `config.js` script which holds the configuration.

```javascript
module.exports = {
    serverPort: 3009,  // The port this server should run on
    dockerRepo: ''     // If empty, defaults to hub.docker.com. 
}
```