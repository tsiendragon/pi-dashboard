import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

it('server protected-path initialization uses actually imported helpers without starting the server', async () => {
  const ts = await import('typescript')
  const source = await readFile(new URL('../server.ts', import.meta.url), 'utf8')
  const file = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
  const context: Record<string, unknown> = { liveSessionAuth: { tokenPath: '/tmp/control/token' } }
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const module = ['path', 'node:path'].includes(statement.moduleSpecifier.text) ? path : ['os', 'node:os'].includes(statement.moduleSpecifier.text) ? os : undefined
    if (!module) continue
    if (statement.importClause?.name) context[statement.importClause.name.text] = module
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) context[bindings.name.text] = module
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) context[binding.name.text] = (module as unknown as Record<string, unknown>)[binding.propertyName?.text || binding.name.text]
  }
  let expression: string | undefined
  const visit = (node: import('typescript').Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(file) === 'SupervisorRuntime') {
      const options = node.arguments?.[0]
      if (options && ts.isObjectLiteralExpression(options)) for (const property of options.properties) if (ts.isPropertyAssignment(property) && property.name.getText(file) === 'protectedPaths') expression = property.initializer.getText(file)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(expression).toBeDefined()
  expect(Array.from(runInNewContext(expression!, context) as string[])).toEqual(['/tmp/control', path.join(os.homedir(), '.pi', 'dashboard-token')])
})
