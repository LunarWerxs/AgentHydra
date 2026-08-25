// English base catalog — the source every other locale is translated from.
// Namespaced per component/area; each area's keys live in ./en/<area>.ts.
import analytics from './en/analytics'
import app from './en/app'
import builder from './en/builder'
import cliInstances from './en/cliInstances'
import codexInstances from './en/codexInstances'
import composer from './en/composer'
import instances from './en/instances'
import notifications from './en/notifications'
import orchestrator from './en/orchestrator'
import queue from './en/queue'
import run from './en/run'
import scheduler from './en/scheduler'
import sessions from './en/sessions'
import settings from './en/settings'

export default {
  analytics,
  app,
  builder,
  cliInstances,
  codexInstances,
  composer,
  instances,
  notifications,
  orchestrator,
  queue,
  run,
  scheduler,
  sessions,
  settings,
}
