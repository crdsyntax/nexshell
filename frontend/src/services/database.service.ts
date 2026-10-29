import { ipc } from '@/lib/api'
import type { DbInfo, DbLoginTest, DbPasswordResult, DbUser } from '@/types'

export const databaseService = {
  info: (profileId: string) =>
    ipc.invoke<DbInfo>('database_info', { profileId }),
  users: (profileId: string) =>
    ipc.invoke<DbUser[]>('database_users', { profileId }),
  grants: (profileId: string, user: string, host: string) =>
    ipc.invoke<string>('database_grants', { profileId, user, host }),
  changePassword: (
    profileId: string,
    user: string,
    host: string,
    password: string,
    testHost: string,
    testPort: number,
    testDatabase: string,
  ) =>
    ipc.invoke<DbPasswordResult>('database_change_password', {
      profileId,
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
  ) =>
    ipc.invoke<DbLoginTest>('database_test_login', {
      profileId,
      user,
      host,
      password,
      port,
      database,
    }),
}
