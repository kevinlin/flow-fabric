import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { InstanceStore } from '../engine-host/store.js';
import type { EngineHost } from '../engine-host/engine-host.js';
import type { Inbox } from '../inbox/inbox.js';
import type { DefinitionStore } from '../definitions/store.js';
import { OutputValidationError } from '../runners/validate.js';

export interface ApiDeps {
  store: InstanceStore;
  host: EngineHost;
  inbox: Inbox;
  definitions?: DefinitionStore;
}

export function buildApi({ store, host, inbox, definitions }: ApiDeps): FastifyInstance {
  const app = Fastify();

  app.get('/api/healthz', async () => ({ ok: true }));

  app.post('/api/instances', async (req, reply) => {
    const body = req.body as {
      name: string;
      source: string;
      workspacePath: string;
      dryRun?: boolean;
      inputs?: Record<string, unknown>;
      stubOverrides?: Record<string, Record<string, unknown>>;
    };
    const id = randomUUID();
    try {
      // start() inserts the row synchronously (so the workspace-lock conflict
      // throws here), then runs to completion in the background.
      const completion = host.start({
        id,
        name: body.name,
        source: body.source,
        workspace: body.workspacePath,
        variables: body.inputs,
        dryRun: body.dryRun,
        stubOverrides: body.stubOverrides,
      });
      completion.catch((err) => app.log.error({ err, id }, 'instance failed'));
    } catch (err) {
      if (String(err).includes('UNIQUE constraint failed')) {
        return reply
          .code(409)
          .send({ error: `workspace ${body.workspacePath} already has an active instance` });
      }
      throw err;
    }
    return reply.code(201).send({ id });
  });

  app.get('/api/instances', async () => ({ instances: store.listInstances() }));

  app.get('/api/instances/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const instance = store.getInstance(id);
    if (!instance) return reply.code(404).send({ error: 'not found' });
    return {
      instance,
      timeline: store.listTaskExecutions(id),
      events: store.listEvents(id),
    };
  });

  app.post('/api/instances/:id/abort', async (req, reply) => {
    await host.abort((req.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get('/api/inbox', async () => ({
    userTasks: inbox.listPending(),
    incidents: store.listOpenIncidents(),
  }));

  app.post('/api/user-tasks/:id/submit', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { vars } = req.body as { vars: Record<string, unknown> };
    try {
      await inbox.submit(id, vars);
      return reply.code(204).send();
    } catch (err) {
      const code = err instanceof OutputValidationError ? 400 : 404;
      return reply.code(code).send({ error: String(err) });
    }
  });

  app.post('/api/incidents/:id/resolve', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { action, output } = req.body as {
      action: 'retry' | 'skip' | 'abort';
      output?: Record<string, unknown>;
    };
    try {
      await host.resolveIncident(id, action, output);
      return reply.code(204).send();
    } catch (err) {
      const code = err instanceof OutputValidationError ? 400 : 409;
      return reply.code(code).send({ error: String(err) });
    }
  });

  app.get('/api/events', async (req, reply) => {
    const { instanceId } = req.query as { instanceId?: string };
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    const unsubscribe = store.onEvent((event) => {
      if (instanceId && event.instanceId !== instanceId) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.raw.on('close', () => {
      unsubscribe();
      reply.raw.end();
    });
    return reply; // keep the connection open
  });

  if (definitions) {
    app.post('/api/definitions', async (req, reply) => {
      const { name, xml } = req.body as { name: string; xml: string };
      const { id, versionNo } = definitions.upload(name, xml);
      return reply.code(201).send({ id, versionNo });
    });

    app.get('/api/definitions', async () => ({ definitions: definitions.listDefinitions() }));

    app.get('/api/definitions/:id/versions/:v', async (req, reply) => {
      const { id, v } = req.params as { id: string; v: string };
      const version =
        v === 'latest' ? definitions.getLatestVersion(id) : definitions.getVersion(id, Number(v));
      if (!version) return reply.code(404).send({ error: 'not found' });
      return version;
    });
  }

  return app;
}
