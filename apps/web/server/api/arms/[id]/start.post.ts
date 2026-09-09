export default defineEventHandler(async (event) => {
  const armId = getRouterParam(event, 'id');
  if (!armId) throw createError({ statusCode: 400, statusMessage: 'invalid_request' });

  const body = await readBody<{ params?: Record<string, unknown> }>(event).catch(
    () => ({}) as { params?: Record<string, unknown> },
  );
  const client = supervisorClient(event);

  return relay(() => client.start(armId, body?.params ?? {}));
});
