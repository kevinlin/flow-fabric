export const FLOWFABRIC_NS = 'http://flowfabric.dev/schema/1.0';

const body = (name: string) => ({
  name,
  superClass: ['Element'],
  properties: [{ name: 'text', isBody: true, type: 'String' }],
});

export const flowfabricModdle = {
  name: 'FlowFabric',
  uri: FLOWFABRIC_NS,
  prefix: 'flowfabric',
  xml: { tagAlias: 'lowerCase' },
  types: [
    {
      name: 'AgentTask',
      superClass: ['Element'],
      properties: [
        { name: 'retries', isAttr: true, type: 'Integer' },
        { name: 'timeoutSeconds', isAttr: true, type: 'Integer' },
        { name: 'prompt', type: 'Prompt' },
        { name: 'tools', type: 'Tools' },
        { name: 'boundaries', type: 'Boundaries' },
        { name: 'inputs', isMany: true, type: 'Input' },
        { name: 'outputSchema', type: 'OutputSchema' },
      ],
    },
    {
      name: 'CodeTask',
      superClass: ['Element'],
      properties: [
        { name: 'command', isAttr: true, type: 'String' },
        { name: 'retries', isAttr: true, type: 'Integer' },
        { name: 'timeoutSeconds', isAttr: true, type: 'Integer' },
        { name: 'inputs', isMany: true, type: 'Input' },
        { name: 'outputSchema', type: 'OutputSchema' },
      ],
    },
    {
      name: 'UserTask',
      superClass: ['Element'],
      properties: [{ name: 'formSchema', type: 'FormSchema' }],
    },
    {
      name: 'Input',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'type', isAttr: true, type: 'String' },
      ],
    },
    {
      name: 'InstanceInputs',
      superClass: ['Element'],
      properties: [{ name: 'inputs', isMany: true, type: 'Input' }],
    },
    body('Prompt'),
    body('Tools'),
    body('Boundaries'),
    body('OutputSchema'),
    body('FormSchema'),
  ],
};
