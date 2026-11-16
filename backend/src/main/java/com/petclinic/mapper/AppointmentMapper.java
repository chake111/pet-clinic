package com.petclinic.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.petclinic.entity.Appointment;
import lombok.Data;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * 预约订单查询。统计口径统一：doctorId 传 null 表示全院，传值表示只看这一位医生
 * （医生登录后台看板时用的就是后者）。
 *
 * null 参数一律显式声明 jdbcType=BIGINT，否则部分驱动会在 setNull 时报无类型参数。
 */
public interface AppointmentMapper extends BaseMapper<Appointment> {

    /**
     * 锁定单张预约。已有预约的每一次状态写入都要先走它，再在锁内重读状态与归属——
     * 普通 selectById 拿到的是快照，两个请求可以各自读到"待接诊"然后各退一次号。
     */
    @Select("SELECT * FROM appointment WHERE id = #{id} AND deleted = 0 FOR UPDATE")
    Appointment selectByIdForUpdate(@Param("id") Long id);

    /**
     * 按幂等键回读原单。raw @Select 不会自动追加逻辑删除条件，必须显式写 deleted = 0，
     * 否则已删除的历史单会挡住客户端用同一个键重新下单。
     */
    @Select("SELECT * FROM appointment WHERE user_id = #{userId} AND idem_key = #{idemKey} AND deleted = 0 LIMIT 1")
    Appointment selectByUserAndIdemKey(@Param("userId") Long userId, @Param("idemKey") String idemKey);

    /**
     * 超时未支付的候选 id。只取 id、按 id 稳定排序，真正的判定留在锁内重做；
     * 截止线由调用方算一次传进来，和支付接口用同一个值。
     */
    @Select("SELECT id FROM appointment "
            + "WHERE deleted = 0 AND status = 0 AND pay_status = 0 AND create_time <= #{cutoff} "
            + "ORDER BY id")
    List<Long> selectUnpaidOverdueIds(@Param("cutoff") LocalDateTime cutoff);

    /**
     * 未到诊候选 id（R3）：只有"仍挂待接诊 + 已支付 + 已过就诊日"才算爽约。
     * 已接诊的单不改判——医生已经动过手，跨日只是没收尾，把它改成未到诊会抹掉真实诊疗记录；
     * 未支付的过期单由超时清扫取消并退号，两条路互不重叠，谁先跑都不影响终态。
     */
    @Select("SELECT id FROM appointment "
            + "WHERE deleted = 0 AND status = 0 AND pay_status = 1 AND appointment_date < CURDATE() ORDER BY id")
    List<Long> selectStaleVisitIds();

    /** 近 N 天的单量与营收趋势，按就诊日期聚合 */
    @Select("""
            SELECT DATE_FORMAT(appointment_date, '%Y-%m-%d') AS day,
                   COUNT(*)                                  AS cnt,
                   SUM(CASE WHEN pay_status = 1 THEN amount ELSE 0 END) AS income
            FROM appointment
            WHERE deleted = 0
              AND (#{doctorId,jdbcType=BIGINT} IS NULL OR doctor_id = #{doctorId,jdbcType=BIGINT})
              AND appointment_date BETWEEN DATE_SUB(CURDATE(), INTERVAL #{days} DAY) AND CURDATE()
            GROUP BY day ORDER BY day
            """)
    List<Map<String, Object>> statDaily(@Param("days") int days, @Param("doctorId") Long doctorId);

    /** 按订单状态分布 */
    @Select("""
            SELECT status, COUNT(*) AS cnt FROM appointment
            WHERE deleted = 0
              AND (#{doctorId,jdbcType=BIGINT} IS NULL OR doctor_id = #{doctorId,jdbcType=BIGINT})
              AND appointment_date BETWEEN DATE_SUB(CURDATE(), INTERVAL #{days} DAY) AND CURDATE()
            GROUP BY status ORDER BY status
            """)
    List<Map<String, Object>> statStatus(@Param("days") int days, @Param("doctorId") Long doctorId);

    /** 按科室分布，已取消的不计 */
    @Select("""
            SELECT dep.name AS name, COUNT(*) AS cnt
            FROM appointment a JOIN department dep ON dep.id = a.department_id
            WHERE a.deleted = 0 AND a.status <> 3
              AND (#{doctorId,jdbcType=BIGINT} IS NULL OR a.doctor_id = #{doctorId,jdbcType=BIGINT})
              AND a.appointment_date BETWEEN DATE_SUB(CURDATE(), INTERVAL #{days} DAY) AND CURDATE()
            GROUP BY dep.name ORDER BY cnt DESC
            """)
    List<Map<String, Object>> statDepartment(@Param("days") int days, @Param("doctorId") Long doctorId);

    /** 医生接诊量排行 */
    @Select("""
            SELECT d.name AS name, COUNT(*) AS cnt
            FROM appointment a JOIN doctor d ON d.id = a.doctor_id
            WHERE a.deleted = 0 AND a.status = 2
              AND a.appointment_date BETWEEN DATE_SUB(CURDATE(), INTERVAL #{days} DAY) AND CURDATE()
            GROUP BY d.id, d.name ORDER BY cnt DESC LIMIT #{limit}
            """)
    List<Map<String, Object>> statTopDoctors(@Param("days") int days, @Param("limit") int limit);

    /**
     * 今日数字卡片的五格：总单量、分流三态与营收，一次条件聚合取回。
     *
     * <p>原先这是五条独立语句（4×COUNT + 1×SUM），各自扫一遍 appointment 再回传，
     * 一次看板请求要在同一天的数据上做五遍相同的过滤。合成一条后只有一次往返、一次扫描。
     *
     * <p><strong>计数口径逐项等价</strong>：
     * <ul>
     *   <li>{@code SUM(status = 0)} 等价于 {@code COUNT WHERE status = 0}，0 行时 SUM 返回 NULL
     *       由 IFNULL 兜成 0；{@code status} 是 {@code NOT NULL DEFAULT 0}，不会出现 NULL 行；</li>
     *   <li>"不限状态"就是整行参与计数，不需要单独一条 COUNT(*)。</li>
     * </ul>
     *
     * <p><strong>日期基准统一到数据库时钟</strong>（{@code CURDATE()}）。这与
     * {@code statDaily} 的 {@code BETWEEN ... CURDATE()} 同口径，也让数字卡片与折线图
     * 最后一天对得上。原先四项 COUNT 走 JVM 的 {@code LocalDate.now()}、营收走
     * {@code CURDATE()}：JVM 与 DB 时区不一致时（容器 UTC + DB Asia/Shanghai），
     * 北京时间 00:00–08:00 之间两者会给出互相矛盾的数字。本次顺带消掉了这个内部矛盾。
     *
     * <p><strong>{@code orders} 含已取消与未到诊</strong>：它是 {@code COUNT(*)}，
     * 而三态只覆盖 status 0/1/2。因此 {@code pending + accepted + finished} 不等于
     * {@code orders}——这是原有口径（旧 countToday 传 null 时不加状态谓词），不是本次引入。
     *
     * <p>索引：{@code idx_visit_date (appointment_date)} 让这条（等值）与其它按日期取数的
     * 统计（趋势/分布是 {@code BETWEEN}，走 range）都从全表扫变成索引定位；
     * 医生视角的过滤列 doctor_id 由已有的
     * {@code idx_doctor_date(doctor_id, appointment_date)} 承担。
     */
    @Select("""
            SELECT COUNT(*)                                                                AS orders,
                   IFNULL(SUM(status = 0), 0)                                             AS pending,
                   IFNULL(SUM(status = 1), 0)                                             AS accepted,
                   IFNULL(SUM(status = 2), 0)                                             AS finished,
                   IFNULL(SUM(CASE WHEN pay_status = 1 THEN amount ELSE 0 END), 0)        AS income
            FROM appointment
            WHERE deleted = 0 AND appointment_date = CURDATE()
              AND (#{doctorId,jdbcType=BIGINT} IS NULL OR doctor_id = #{doctorId,jdbcType=BIGINT})
            """)
    TodayCard todayCard(@Param("doctorId") Long doctorId);

    /**
     * 今日五格的一行；类型用 long / BigDecimal 与 VO 字段对齐，省得在服务层再做拆箱。
     *
     * <p><strong>四个计数列必须由 SQL 保证非 NULL</strong>（各有 {@code COUNT(*)} 或
     * {@code IFNULL}）。若以后去掉 IFNULL，MyBatis 往 {@code long} setter 写 null 会抛
     * {@code IllegalArgumentException}，而不是给出"某列为空"的可读错误。
     */
    @Data
    class TodayCard {
        private long orders;
        private long pending;
        private long accepted;
        private long finished;
        private BigDecimal income;
    }

    /** 服务过的患者数 / 宠物数。医生看板用它替代全院注册用户数 */
    @Select("""
            SELECT COUNT(DISTINCT user_id) AS users, COUNT(DISTINCT pet_id) AS pets
            FROM appointment
            WHERE deleted = 0 AND status <> 3
              AND (#{doctorId,jdbcType=BIGINT} IS NULL OR doctor_id = #{doctorId,jdbcType=BIGINT})
            """)
    ServedCount countServed(@Param("doctorId") Long doctorId);

    /** 两个 COUNT 拼一行回来，省一次往返 */
    @Data
    class ServedCount {
        private Long users;
        private Long pets;
    }
}
