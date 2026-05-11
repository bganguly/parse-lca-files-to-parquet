import * as duckdb from '@duckdb/duckdb-wasm'
import duckdbMvpWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import duckdbEhWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import duckdbMvpWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbEhWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

export const DUCKDB_H1B_TABLE = 'h1b_raw'

const LOCAL_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdbMvpWasmUrl,
    mainWorker: duckdbMvpWorkerUrl,
  },
  eh: {
    mainModule: duckdbEhWasmUrl,
    mainWorker: duckdbEhWorkerUrl,
  },
}

type QueryResult = {
  columns: string[]
  rows: Record<string, unknown>[]
}

class DuckDbEngine {
  private db: duckdb.AsyncDuckDB | null = null
  private conn: duckdb.AsyncDuckDBConnection | null = null
  private loadedSource = ''

  private async init() {
    if (this.db && this.conn) {
      return
    }

    const bundle = await duckdb.selectBundle(LOCAL_BUNDLES)
    const worker = new Worker(bundle.mainWorker!)
    const logger = new duckdb.ConsoleLogger()

    this.db = new duckdb.AsyncDuckDB(logger, worker)
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    this.conn = await this.db.connect()
  }

  async loadDatasetToH1bTable(sourcePath: string) {
    await this.init()

    if (!this.conn) {
      throw new Error('DuckDB connection is not initialized.')
    }

    if (this.loadedSource === sourcePath) {
      return
    }

    const escaped = sourcePath.replace(/'/g, "''")
    const isParquet = /\.parquet($|\?)/i.test(sourcePath)
    const isParquetPartitionPath = /year=\*/i.test(sourcePath)
    const reader = isParquet || isParquetPartitionPath
      ? `read_parquet('${escaped}')`
      : `read_csv_auto('${escaped}', HEADER = TRUE, SAMPLE_SIZE = -1)`

    await this.conn.query(`
      CREATE OR REPLACE TABLE ${DUCKDB_H1B_TABLE} AS
      SELECT *
      FROM ${reader}
    `)

    this.loadedSource = sourcePath
  }

  async executeSql(sql: string): Promise<QueryResult> {
    await this.init()

    if (!this.conn) {
      throw new Error('DuckDB connection is not initialized.')
    }

    const result = await this.conn.query(sql)
    const columns = result.schema.fields.map((field) => field.name)

    const rows = result.toArray().map((row) => {
      if (typeof row.toJSON === 'function') {
        return row.toJSON() as Record<string, unknown>
      }

      return row as unknown as Record<string, unknown>
    })

    return { columns, rows }
  }
}

export const duckDbEngine = new DuckDbEngine()
