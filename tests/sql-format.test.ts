import { describe, expect, it } from 'vitest'
import { formatSqlTemplate } from '../src/renderer/src/utils/sql-format'

describe('MyBatis SQL 格式化', () => {
  it('原样保留时长、JDBC 配置、属性索引与动态表名参数', () => {
    const placeholders = ['#{time}', '#{query.beginTime,jdbcType=TIMESTAMP}', '#{items[0].id}', '${tableName}', '${map["a{b}"]}']
    const result = formatSqlTemplate(`select ${placeholders[0]}, ${placeholders[1]} from ${placeholders[3]} where id=${placeholders[2]} and value=${placeholders[4]} and state=?`)
    for (const placeholder of placeholders) expect(result).toContain(placeholder)
    expect(result).toMatch(/SELECT\s+#{time}/)
    expect(result).toContain('state = ?')
  })

  it('动态 XML 标签、属性、比较实体均不被 SQL 格式化器拆坏', () => {
    const input = '<select id="find" resultType="Order">select * from orders <where><if test="time != null and time > 0">created_at &lt;= #{time}</if></where></select>'
    const result = formatSqlTemplate(input)
    for (const tag of ['<select id="find" resultType="Order">', '<where>', '<if test="time != null and time > 0">', '</if>', '</where>', '</select>']) expect(result).toContain(tag)
    expect(result).toContain('created_at &lt;= #{time}')
    expect(result).toMatch(/SELECT\s+\*\s+FROM\s+orders/)
    expect(formatSqlTemplate(result)).toBe(result)
  })

  it('支持 foreach 与 CDATA，保持模板可以重新粘贴到 XML', () => {
    const foreach = '<foreach collection="ids" item="id" open="(" close=")" separator=",">'
    const result = formatSqlTemplate(`<select id="find">select * from t where created_at <![CDATA[ <= ]]> #{time} and id in ${foreach}#{id}</foreach></select>`)
    expect(result).toContain(foreach)
    expect(result).toContain('</foreach>')
    expect(result).toContain('<![CDATA[')
    expect(result).toContain(']]>')
    expect(result).toContain('<=')
    expect(result).toContain('#{time}')
    expect(result).not.toContain('< foreach')
  })

  it('格式化操作不会改写字面量中的 XML 实体、空格和伪占位符', () => {
    const literal = "'a  &lt; b #{broken <if test=\"x\">'"
    const result = formatSqlTemplate(`select ${literal} as title, "my table" from t where count &gt;= 1`)
    expect(result).toContain(literal)
    expect(result).toContain('"my table"')
    expect(result).toContain('count >= 1')
  })

  it('模板保护标记不能与用户 SQL 标识符碰撞', () => {
    const result = formatSqlTemplate('select __TOOLBOX_SQL_0__, #{time} from t')
    expect(result).toContain('__TOOLBOX_SQL_0__')
    expect(result).toContain('#{time}')
  })

  it('SQL 行注释仍以换行结束，不会吞掉后续条件', () => {
    const result = formatSqlTemplate('select * from t -- #{ignored}\nwhere id=#{id}')
    expect(result).toMatch(/-- #{ignored}\n\s*WHERE/)
    expect(result).toContain('id = #{id}')
  })

  it('不完整参数和 CDATA 返回可直接修正的错误', () => {
    expect(() => formatSqlTemplate('select * from t\nwhere id=#{time')).toThrow('MyBatis 占位符未闭合（第 2 行）')
    expect(() => formatSqlTemplate('select #{}')).toThrow('不能为空')
    expect(() => formatSqlTemplate('select <![CDATA[ * from t')).toThrow('CDATA 未闭合')
  })
})
