#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/23b6c85a86e41a6df7c4cf1ce29387a439ba4a31c8e4bda9615f63dcf9181684/contract';
import startContract from '../../snapshots/23b6c85a86e41a6df7c4cf1ce29387a439ba4a31c8e4bda9615f63dcf9181684/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a55f72e27d55037650dbc46e3ca46537e54218a8644cfa037e8062fdb44d0720/contract';
import endContract from '../../snapshots/a55f72e27d55037650dbc46e3ca46537e54218a8644cfa037e8062fdb44d0720/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [this.dropTable({ schema: 'public', table: 'outbox' })];
  }
}

MigrationCLI.run(import.meta.url, M);
