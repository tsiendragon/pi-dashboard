import { readFile } from 'node:fs/promises'

export interface LarkAccount {
  id: string
  name: string
  appId: string
  appSecret: string
  /** 'feishu' (open.feishu.cn) or 'lark' (open.larksuite.com). Long-connection is domain-isolated. */
  domain?: 'feishu' | 'lark'
}

export interface AccountsFile {
  version: 1
  activeId: string | null
  accounts: LarkAccount[]
  /** Users allowed to drive the gateway. Empty / absent = unrestricted. */
  allowedUserIds?: string[]
}

/** Read the dashboard-managed accounts file (written by backend/routes/lark.ts). */
export async function readAccounts(filePath: string): Promise<AccountsFile> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as AccountsFile
    if (parsed?.version === 1 && Array.isArray(parsed.accounts)) return parsed
  } catch {
    /* missing or invalid -> empty */
  }
  return { version: 1, activeId: null, accounts: [] }
}

/** The single active account (B mode), if configured and active. */
export async function readActiveAccount(filePath: string): Promise<LarkAccount | undefined> {
  const file = await readAccounts(filePath)
  return file.accounts.find(account => account.id === file.activeId)
}

/** Allow-list configured from the dashboard (empty array = unrestricted). */
export async function readAllowedUserIds(filePath: string): Promise<string[]> {
  const file = await readAccounts(filePath)
  return Array.isArray(file.allowedUserIds) ? file.allowedUserIds.filter(Boolean) : []
}
