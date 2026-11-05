import { ipc } from '@/lib/api'
import type { DbAuth, DbInfo, DbLoginTest, DbPasswordResult, DbUser } from '@/types'

export const databaseService = {
  info: (profileId: string, auth: DbAuth) =>
    ipc.invoke<DbInfo>('database_info', { profileId, auth }),
  users: (profileId: string, auth: DbAuth) =>
    ipc.invoke<DbUser[]>('database_users', { profileId, auth }),
  grants: (profileId: string, auth: DbAuth, user: string, host: string) =>
    ipc.invoke<string>('database_grants', { profileId, auth, user, host }),
  changePassword: (
    profileId: string,
    auth: DbAuth,
    user: string,
    host: string,
    password: string,
    testHost: string,
    testPort: number,
    testDatabase: string,
  ) =>
    ipc.invoke<DbPasswordResult>('database_change_password', {
      profileId,
      auth,
      user,
      host,
      password,
      testHost,
      testPort,
      testDatabase,
    }),
  testLogin: (
    profileId: string,
    user: string,
    host: string,
    password: string,
    port: number,
    database: string,
    engine?: 'mysql' | 'mariadb' | 'mongodb',
    authDb?: string,
  ) =>
    ipc.invoke<DbLoginTest>('database_test_login', {
      profileId,
      user,
      host,
      password,
      port,
      database,
      engine,
      authDb,
    }),
}
