/*
 * signalk-humidity-history
 *
 * Serves a webapp that charts relative-humidity history straight from the
 * local InfluxDB (the same database signalk-to-influxdb writes to). The plugin
 * itself only exposes a small REST endpoint that runs the InfluxDB query
 * server-side, so no database credentials ever reach the browser.
 *
 * InfluxDB 1.x stores each Signal K path as its own measurement, with the
 * sample in the "value" column. relativeHumidity is a ratio 0..1, so the query
 * multiplies by 100 to return percent.
 */

const DEFAULT_SERIES = [
  { path: 'environment.inside.relativeHumidity', label: 'Inne' },
  { path: 'environment.outside.relativeHumidity', label: 'Ute' }
]

// The chart never needs raw per-second data; aim for roughly this many points
// across whatever range is requested and let InfluxDB downsample with mean().
const TARGET_POINTS = 500

module.exports = function (app) {
  const plugin = {}
  let options = {}

  plugin.id = 'signalk-humidity-history'
  plugin.name = 'Humidity History'
  plugin.description =
    'Charts relativeHumidity history from the local InfluxDB, with selectable ' +
    'time ranges (1/2/5/7/14 days).'

  plugin.schema = () => ({
    type: 'object',
    title: 'Humidity History',
    properties: {
      influxHost: {
        type: 'string',
        title: 'InfluxDB host',
        default: 'localhost'
      },
      influxPort: {
        type: 'number',
        title: 'InfluxDB port',
        default: 8086
      },
      database: {
        type: 'string',
        title: 'InfluxDB database',
        default: 'libelle'
      },
      username: {
        type: 'string',
        title: 'InfluxDB username (leave blank if auth is off)',
        default: ''
      },
      password: {
        type: 'string',
        title: 'InfluxDB password (leave blank if auth is off)',
        default: ''
      },
      series: {
        type: 'array',
        title: 'Series to chart',
        description: 'Each entry is one InfluxDB measurement (a Signal K path).',
        default: DEFAULT_SERIES,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', title: 'Signal K path / measurement' },
            label: { type: 'string', title: 'Legend label' }
          }
        }
      }
    }
  })

  plugin.start = function (opts) {
    options = Object.assign(
      {
        influxHost: 'localhost',
        influxPort: 8086,
        database: 'libelle',
        username: '',
        password: '',
        series: DEFAULT_SERIES
      },
      opts || {}
    )
    if (!Array.isArray(options.series) || options.series.length === 0) {
      options.series = DEFAULT_SERIES
    }
    app.setPluginStatus(`Serving humidity history (${options.series.length} series)`)
  }

  plugin.stop = function () {}

  // ---- InfluxDB query ------------------------------------------------------

  // Snap the group-by interval to a "nice" minute value so axis ticks land on
  // sensible times rather than e.g. every 17 minutes.
  function groupMinutes (days) {
    const raw = (days * 24 * 60) / TARGET_POINTS
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
    for (const s of steps) {
      if (raw <= s) return s
    }
    return 1440
  }

  async function queryInflux (days) {
    const minutes = groupMinutes(days)
    const statements = options.series
      .map((s) => {
        // Quote the measurement as an InfluxQL identifier; escape any embedded
        // quote/backslash so a configured path can't break the query.
        const m = s.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        return (
          `SELECT mean("value")*100 FROM "${m}" ` +
          `WHERE time > now() - ${days}d ` +
          `GROUP BY time(${minutes}m) fill(none)`
        )
      })
      .join('; ')

    const params = new URLSearchParams({
      db: options.database,
      epoch: 'ms',
      q: statements
    })
    if (options.username) {
      params.set('u', options.username)
      params.set('p', options.password)
    }

    const url = `http://${options.influxHost}:${options.influxPort}/query?${params.toString()}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) {
      throw new Error(`InfluxDB HTTP ${resp.status}`)
    }
    const body = await resp.json()
    if (body.error) {
      throw new Error(body.error)
    }

    // results[] line up with the statements we sent, in order.
    return options.series.map((s, i) => {
      const result = (body.results && body.results[i]) || {}
      const serie = result.series && result.series[0]
      const points = serie ? serie.values : []
      return { path: s.path, label: s.label || s.path, points }
    })
  }

  // ---- REST API for the webapp ---------------------------------------------

  async function dataHandler (req, res) {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 7))
    try {
      const series = await queryInflux(days)
      res.json({ days, groupMinutes: groupMinutes(days), series })
    } catch (e) {
      app.error(`humidity-history query failed: ${e.message}`)
      res.status(500).json({ error: e.message })
    }
  }

  // The webapp reads this route. It is mounted under /signalk/v1/api, NOT under
  // /plugins, on purpose: the server guards every /plugins/* route with
  // adminAuthenticationMiddleware (admin only), so a plain webapp — even with a
  // device token — gets 401 there. Routes under /signalk/v1/api instead honour
  // the server's "Allow readonly access" setting, so the same anonymous browser
  // that can already read the live values can also read their history.
  //   GET /signalk/v1/api/humidity-history/data?days=7
  plugin.signalKApiRoutes = function (router) {
    router.get('/humidity-history/data', dataHandler)
    return router
  }

  // Also expose it under /plugins for admin/OpenAPI tooling.
  plugin.registerWithRouter = function (router) {
    router.get('/data', dataHandler)
  }

  plugin.getOpenApi = () => ({
    openapi: '3.0.0',
    info: { title: 'Humidity History plugin API', version: '0.1.0' },
    paths: {
      '/data': {
        get: {
          summary: 'Downsampled relativeHumidity history (percent) per series',
          parameters: [
            {
              name: 'days',
              in: 'query',
              schema: { type: 'integer', default: 7 },
              description: 'Range in days (1..365)'
            }
          ],
          responses: { 200: { description: 'History JSON' } }
        }
      }
    }
  })

  return plugin
}
