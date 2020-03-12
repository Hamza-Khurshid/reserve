'use strict'

const logError = require('./logError')
const {
  $configurationInterface,
  $configurationRequests,
  $dispatcherEnd,
  $mappingMethod,
  $requestPromise,
  $requestRedirectCount,
  $responseEnded
} = require('./symbols')

function hookEnd (response) {
  if (!response.end[$dispatcherEnd]) {
    const end = response.end
    response.end = function () {
      this[$responseEnded] = true
      return end.apply(this, arguments)
    }
    response.end[$dispatcherEnd] = true
  }
  return response
}

function redirected () {
  const end = new Date()
  const redirectedInfos = Object.assign(this.emitParameters, {
    end,
    timeSpent: end - this.emitParameters.start,
    statusCode: this.response.statusCode
  })
  this.eventEmitter.emit('redirected', redirectedInfos)
  this.resolve(redirectedInfos)
}

function error (reason) {
  let statusCode
  if (typeof reason === 'number') {
    statusCode = reason
  } else {
    statusCode = 500
  }
  const errorParameters = { ...this.emitParameters, reason }
  try {
    this.eventEmitter.emit('error', errorParameters)
  } catch (e) {
    // Unhandled error
    logError(errorParameters)
  }
  if (this.failed) {
    // Error during error: finalize the response (whatever it means)
    this.response.end()
    return redirected.call(this)
  }
  this.failed = true
  return dispatch.call(this, statusCode)
}

function redirecting ({ mapping, match, handler, type, redirect, url, index = 0 }) {
  this.eventEmitter.emit('redirecting', Object.assign(this.emitParameters, { type, redirect }))
  try {
    return handler.redirect({
      configuration: this.configuration[$configurationInterface],
      mapping,
      match,
      redirect,
      request: this.request,
      response: hookEnd(this.response)
    })
      .then(result => {
        if (undefined !== result) {
          const redirectCount = ++this.request[$requestRedirectCount]
          if (redirectCount > this.configuration['max-redirect']) {
            return error.call(this, 508)
          }
          return dispatch.call(this, result)
        }
        if (this.response[$responseEnded]) {
          return redirected.call(this)
        }
        return dispatch.call(this, url, index + 1)
      }, error.bind(this))
  } catch (e) {
    return error.call(this, e)
  }
}

function interpolate (match, redirect) {
  if (typeof redirect === 'string') {
    return redirect.replace(/\$(\d+|\$)/g, (token, sIndex) => {
      if (sIndex === '$') {
        return '$'
      } else {
        return match[sIndex] || ''
      }
    })
  }
  return redirect
}

function tryMatch (mapping, method, url) {
  if (mapping[$mappingMethod] && !mapping[$mappingMethod].includes(method)) {
    return null
  }
  return mapping.match.exec(url)
}

function dispatch (url, index = 0) {
  if (typeof url === 'number') {
    return redirecting.call(this, {
      type: 'status',
      handler: this.configuration.handlers.status,
      redirect: url
    })
  }
  const length = this.configuration.mappings.length
  while (index < length) {
    const mapping = this.configuration.mappings[index]
    const match = tryMatch(mapping, this.request.method, url)
    if (match) {
      const { handler, redirect, type } = this.configuration.handler(mapping)
      return redirecting.call(this, { mapping, match, handler, type, redirect: interpolate(match, redirect), url, index })
    }
    ++index
  }
  return error.call(this, 501)
}

module.exports = function (configuration, request, response) {
  const emitParameters = { method: request.method, url: request.url, start: new Date() }
  let promiseResolver
  const requestPromise = new Promise(resolve => { promiseResolver = resolve })
  this.emit('incoming', emitParameters)
  request[$requestPromise] = requestPromise
  request[$requestRedirectCount] = 0
  const configurationRequests = configuration[$configurationRequests]
  return configurationRequests.hold
    .then(() => {
      configurationRequests.promises.push(requestPromise)
      dispatch.call({ eventEmitter: this, emitParameters, configuration, request, response, resolve: promiseResolver }, request.url)
      return requestPromise
    })
    .then(() => {
      configurationRequests.promises = configurationRequests.promises
        .filter(promise => promise !== requestPromise)
    })
}
