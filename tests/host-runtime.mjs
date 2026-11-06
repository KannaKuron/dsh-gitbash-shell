// Current Core contract: register a provider and dispatch raw call batches.
// These helpers call the real host; they never replace ToolRuntime methods.
export * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
export * as ptcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
export async function executeTool(tools, { name, callId, arguments: args, ...input }) {
  const batch = await tools.execute({ ...input, calls: [{
    type: 'tool_use', id: callId, name, arguments: JSON.stringify(args),
  }] })
  return batch.results[0].result
}
export function sdkSchemas(tools, scope) {
  return tools.definitions(scope).map(tool => ({ name: tool.name, output: tool.output.schema }))
}
