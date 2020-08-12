const PREFIX = '/torrent-together'

const parseRange = require('range-parser')
const registerStreamToSW = require('stream-to-sw')
const WebTorrent = require('webtorrent')
const EventEmitter = require('events').EventEmitter
const fs = require('fs') // brfs is used to inline these as strings
var IdbkvChunkStore = require('idbkv-chunk-store')

const sleep = (duration) => new Promise(resolve => setTimeout(resolve, duration))

const webtorrentClient = new WebTorrent()

// display webtorrent errors at the top of the page in red
webtorrentClient.once('error', (error) => {
  document.body.innerHTML = `
    <code style="color: red">${error}</code>
    ${document.body.innerHTML}`
})

class FloodFill extends EventEmitter {
  constructor () {
    super()

    // associative array of received message IDs (so we know whether to pass it on or drop it)
    this.received = {}
  }

  onMessage (message) {
    // if the message was already received by a different peer
    if (this.received[message.id]) {
      return
    }

    this.setReceived(message.id)
    this.emit('message', message)

    // rebroadcast it to all peers
    this.emit('broadcast', message)
  }

  broadcast (message) {
    const id = Math.random()
    message.id = id
    this.setReceived(id)

    // emit 'broadcast' to let all instances of FloodFillExtension know to send out the message
    this.emit('broadcast', message)
  }

  async setReceived (id) {
    this.received[id] = true

    // should definitely be fully propagated through the network after 20s
    await sleep(20 * 1000)
    delete this.received[id]
  }
}
const floodfill = new FloodFill()

async function addTorrent ({ torrentId, seed = false } = {}) {
  // if existing, use that
  let torrent = webtorrentClient.get(torrentId)

  // these are the default trackers used by instant.io and webtorrent desktop
  const torrentOpts = {
    store: IdbkvChunkStore,
    announce: [
      'wss://tracker.btorrent.xyz',
      'wss://tracker.fastcast.nz',
      'wss://tracker.openwebtorrent.com'
    ]
  }

  if (!torrent) {
    torrent = seed
      ? webtorrentClient.seed(torrentId, torrentOpts)
      : webtorrentClient.add(torrentId, torrentOpts)
  }

  class FloodFillExtension {
    constructor (wire) {
      this._wire = wire
    }

    onExtendedHandshake (handshake) {
      // only broadcast to peers that support the extension
      if (!handshake.m || !handshake.m.flood_fill) {
        return
      }

      // .emit('broadcast', message) is used to send broadcasts
      floodfill.on('broadcast', (message) => {
        const buffer = Buffer.from(JSON.stringify(message))

        this._wire.extended('flood_fill', buffer)
      })
    }

    onMessage (buffer) {
      const message = JSON.parse(buffer.toString())

      floodfill.onMessage(message)
    }
  }
  FloodFillExtension.prototype.name = 'flood_fill'

  torrent.on('wire', (wire) => {
    wire.use(FloodFillExtension)
  })

  // wait for metadata to be available before returning
  if (!torrent.metadata) {
    await new Promise(resolve => torrent.once('metadata', resolve))
  }

  return torrent
}

const streamToSWReady = registerStreamToSW(`${PREFIX}/worker.js`, async (req, res) => {
  // format of intercepted URLs is /magnet/${hashId}
  const hashId = req.path.match(/[a-zA-Z0-9]{40}/)[0]

  const torrent = await addTorrent({ torrentId: hashId })

  // first file in torrent
  const file = torrent.files[0]

  // respond to request with stream of webtorrent file
  res.headers['content-type'] = file._getMimeType() // the mime type of the file
  res.headers['accept-ranges'] = 'bytes' // range headers are supported

  let range
  if (req.headers.range) {
    range = parseRange(file.length, req.headers.range)
  }

  // if the range is an array, then a valid range was requested
  if (Array.isArray(range)) {
    res.status = 206 // successful range request
    res.statusText = 'Partial Content'

    // only respond with the first range specified
    // otherwise multiple streams would be needed, and it gets too complicated
    range = range[0]

    // range description
    res.headers['content-range'] = `bytes ${range.start}-${range.end}/${file.length}`
    // length of response, +1 because both start and end are inclusive
    res.headers['content-length'] = range.end - range.start + 1
  } else {
    // if no range (or an invalid range) was requested, then respond with the entire file

    range = null
    res.headers['content-length'] = file.length // length of response
  }

  if (req.method === 'HEAD') return // return an empty body

  // file.createReadStream() is documented here: https://webtorrent.io/docs
  // it returns a node stream, which is an asyncIterator
  return file.createReadStream(range)
})

main() // hoisted from right below

async function main () {
  // wait until the DOM is available
  if (document.readyState === 'loading') {
    await new Promise((resolve) => {
      window.addEventListener('DOMContentLoaded', resolve, { once: true })
    })
  }

  if (/[a-zA-Z0-9]{40}/.test(window.location.pathname)) {
    watchPage(false)
  } else {
    homepage()
    // reset url if it doesn't match any pages
    window.history.replaceState(null, null, `${PREFIX}`)
  }
}

function homepage () {
  // display homepage
  const homepageHTML = fs.readFileSync('homepage.html', 'utf8') // specifying utf8 makes it return string
  document.body.innerHTML = homepageHTML

  // when form is submitted, go to /${hashId}
  document.getElementById('fileForm').addEventListener('submit', async () => {
    const file = document.getElementById('fileInput').files[0]

    document.getElementById('submitbutton').innerText = 'loading...'
    const torrent = await addTorrent({ torrentId: file, seed: true })

    // update url to the hashId
    window.history.pushState(null, '', `${PREFIX}/${torrent.infoHash}`)
    watchPage({ isHost: true })
  }, { once: true })
}

async function watchPage ({ isHost = false } = {}) {
  // display homepage
  const watchHTML = fs.readFileSync('watch.html', 'utf8') // specifying utf8 makes it return string
  document.body.innerHTML = watchHTML

  const videoElement = document.getElementById('video')

  // wait until streamToSW can intercept the request before setting video src
  await streamToSWReady

  const hashId = window.location.pathname.match(/[a-zA-Z0-9]{40}/)[0]

  videoElement.src = `/torrent-together/magnet/${hashId}`

  if (isHost) {
    // activate controls for the host (and only the host)
    videoElement.controls = true

    const sendStatus = () => {
      floodfill.broadcast({
        paused: videoElement.paused,
        currentTime: videoElement.currentTime,
        timestamp: Date.now()
      })
    }

    // send status on playback change events and then periodically
    // (1s is the minimum interval for background tabs, but that just means some updates will be skipped if it's in the background)
    videoElement.addEventListener('play', sendStatus)
    videoElement.addEventListener('pause', sendStatus)
    setInterval(sendStatus, 500)
  } else {
    // when a broadcast is received
    floodfill.on('message', async (message) => {
      const latency = (Date.now() - message.timestamp) / 1000 // as a float of seconds to match currentTime
      const theirCurrentTime = message.currentTime + (message.paused ? 0 : latency) // no latency error if paused

      // always resync if paused,
      // otherwise only if there's greater than a half-second delay
      // this is to keep playback smooth
      if (videoElement.paused || Math.abs(theirCurrentTime - videoElement.currentTime) > 0.5) {
        console.log('updating video time to match host', message)
        videoElement.currentTime = theirCurrentTime
      }

      // sync paused state
      if (message.paused !== videoElement.paused) {
        message.paused
          ? videoElement.pause()
          : videoElement.play()
      }
    })
  }
}

// playButton.addEventListener('click', async () => {
//   floodfill.broadcast({
//     type: 'play',
//     timestamp: Date.now() + (10 * 1000), // when to play, wait 10s to let people buffer
//     videoTime: videoElement.currentTime
//   })
// })

// case 'play': {
//   console.log('received play message!', 'will start playing at this second: ', message.videoTime, 'at this timestamp: ', message.timestamp)
//   videoElement.play() // play first to make things consistent and ensure buffering begins
//   videoElement.currentTime = message.videoTime
//   videoElement.pause()

//   while (true) {
//     const msLeft = message.timestamp - Date.now()

//     playButton.innerText = `playing in ${Math.floor(msLeft / 1000)}s`

//     if (msLeft >= 2000) {
//       await sleep(1000)
//     } else {
//       await sleep(msLeft)
//       break
//     }
//   }
//   playButton.innerText = 'play'

//   videoElement.play()
//   break
// }
