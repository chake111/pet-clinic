package com.yuzhua.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.yuzhua.common.BizException;
import com.yuzhua.dto.ScheduleBatchForm;
import com.yuzhua.dto.ScheduleEditForm;
import com.yuzhua.dto.ScheduleForm;
import com.yuzhua.entity.Doctor;
import com.yuzhua.entity.DoctorSchedule;
import com.yuzhua.mapper.AppointmentMapper;
import com.yuzhua.mapper.DoctorMapper;
import com.yuzhua.mapper.DoctorScheduleMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 排班时段边界的服务层回归。使用内存替身，不需要数据库，由 {@code mvn test} 直接执行。
 *
 * <p>原先是独立 {@code main} 检查，断言逐条迁移到这里：时段边界、历史排班编辑、
 * 批量重复时段、停诊医生的号源维护与恢复。
 */
class SchedulePeriodCheckTest {

    /** MyBatis-Plus 的列名解析需要先登记实体元数据，整个测试类共用一次 */
    private static boolean tableInfoReady;

    private DoctorSchedule current;
    private DoctorSchedule saved;
    private long refs;
    private int doctorStatus;
    private int statusWrites;

    @BeforeAll
    static void initTableInfo() {
        if (tableInfoReady) {
            return;
        }
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), "test"), DoctorSchedule.class);
        tableInfoReady = true;
    }

    @BeforeEach
    void resetState() {
        current = null;
        saved = null;
        refs = 0;
        doctorStatus = 1;
        statusWrites = 0;
    }

    @SuppressWarnings("unchecked")
    static <T> T mapper(Class<T> type, Function<String, Object> result) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
                (proxy, method, args) -> result.apply(method.getName()));
    }

    class Service extends DoctorScheduleService {
        Service() {
            super(mapper(DoctorMapper.class, name -> {
                Doctor d = new Doctor();
                d.setId(1L);
                d.setStatus(doctorStatus);
                return d;
            }), mapper(AppointmentMapper.class, name -> refs), null);
            baseMapper = mapper(DoctorScheduleMapper.class, name -> current);
        }

        @Override
        public boolean exists(Wrapper<DoctorSchedule> query) {
            return false;
        }

        @Override
        public boolean save(DoctorSchedule row) {
            saved = row;
            return true;
        }

        @Override
        public boolean updateById(DoctorSchedule row) {
            saved = row;
            return true;
        }

        @Override
        public boolean saveBatch(Collection<DoctorSchedule> rows) {
            saved = rows.iterator().next();
            return true;
        }

        @Override
        public DoctorSchedule require(Long id) {
            return current;
        }

        @Override
        public boolean update(Wrapper<DoctorSchedule> query) {
            statusWrites++;
            return true;
        }
    }

    static ScheduleForm form(int period, String start, String end) {
        ScheduleForm f = new ScheduleForm();
        f.setDoctorId(1L);
        f.setWorkDate(LocalDate.now().plusDays(1));
        f.setPeriod(period);
        f.setStartTime(LocalTime.parse(start));
        f.setEndTime(LocalTime.parse(end));
        f.setTotalNum(20);
        f.setStatus(1);
        return f;
    }

    /** 编辑入参：字段与 ScheduleForm 相同，唯独没有 status——状态不在这条写入路径上 */
    static ScheduleEditForm edit(ScheduleForm f) {
        ScheduleEditForm e = new ScheduleEditForm();
        e.setDoctorId(f.getDoctorId());
        e.setWorkDate(f.getWorkDate());
        e.setPeriod(f.getPeriod());
        e.setStartTime(f.getStartTime());
        e.setEndTime(f.getEndTime());
        e.setTotalNum(f.getTotalNum());
        return e;
    }

    static ScheduleBatchForm batch(ScheduleForm f) {
        ScheduleBatchForm b = new ScheduleBatchForm();
        b.setDoctorId(f.getDoctorId());
        b.setStartDate(f.getWorkDate());
        b.setEndDate(f.getWorkDate());
        b.setWeekDays(List.of(f.getWorkDate().getDayOfWeek().getValue()));
        ScheduleBatchForm.PeriodTemplate p = new ScheduleBatchForm.PeriodTemplate();
        p.setPeriod(f.getPeriod());
        p.setStartTime(f.getStartTime());
        p.setEndTime(f.getEndTime());
        p.setTotalNum(20);
        b.setPeriods(List.of(p));
        return b;
    }

    /** 断言被拒绝，且拒绝路径上没有发生任何写入 */
    void reject(Runnable action, String message) {
        saved = null;
        try {
            action.run();
            throw new AssertionError("应拒绝：" + message);
        } catch (BizException e) {
            if (!e.getMessage().contains(message)) {
                throw new AssertionError(e);
            }
        }
        if (saved != null) {
            throw new AssertionError("拒绝前发生了写入");
        }
    }

    /** 三个时段的边界时间本身合法，越界 1 秒即拒绝；批量路径与单条一致 */
    @Test
    void acceptBoundaryTimesForEachPeriod() {
        Service s = new Service();
        String[][] bounds = {{"08:00", "12:00"}, {"13:00", "18:00"}, {"18:00", "22:00"}};
        for (int i = 0; i < bounds.length; i++) {
            ScheduleForm f = form(i + 1, bounds[i][0], bounds[i][1]);
            s.create(f);
            if (!saved.getStartTime().equals(f.getStartTime())) {
                throw new AssertionError("边界时间未保存");
            }
            if (s.batchCreate(batch(f)).created() != 1) {
                throw new AssertionError("批量边界失败");
            }
            f.setStartTime(f.getStartTime().minusSeconds(1));
            reject(() -> s.create(f), "排班时间须在");
            reject(() -> s.batchCreate(batch(f)), "排班时间须在");
            f.setStartTime(LocalTime.parse(bounds[i][0]));
            f.setEndTime(f.getEndTime().plusSeconds(1));
            reject(() -> s.create(f), "排班时间须在");
            reject(() -> s.batchCreate(batch(f)), "排班时间须在");
        }
    }

    /** 时段外、起止相同、起晚于止、非法时段号 */
    @Test
    void rejectInvalidPeriodAndTimeOrder() {
        Service s = new Service();
        reject(() -> s.create(form(1, "14:00", "16:00")), "排班时间须在");
        reject(() -> s.create(form(1, "12:00", "12:00")), "结束时间必须晚于");
        reject(() -> s.create(form(3, "22:00", "18:00")), "结束时间必须晚于");
        reject(() -> s.create(form(4, "09:00", "10:00")), "时段只能是");
    }

    /**
     * 编辑契约的形状：<strong>ScheduleEditForm 不能有 status 字段</strong>。
     *
     * <p>这是 H1 契约层的护栏，和下面 {@code preserveLegacyScheduleOnEdit} 的分工要说清：
     * 那个用例断言的是"实现不发 status"（出参实体上为 null），而真正拦住越权写入的是
     * <em>请求体结构上不存在这个字段</em>。如果将来有人把 status 加回 DTO、并写成
     * "只在非 null 时写入"，出参断言依然全绿，但旧客户端又能改停诊位了。
     * 所以这里直接查反射，字段一旦回来就红。
     */
    @Test
    void editFormHasNoStatusField() {
        for (var field : ScheduleEditForm.class.getDeclaredFields()) {
            if ("status".equals(field.getName())) {
                throw new AssertionError("ScheduleEditForm 不应有 status 字段："
                        + "停诊/恢复只能由 /stop 与 /resume 写入");
            }
        }
        // 六个业务字段必须都在，防止为了"没有 status"把别的字段也删了
        Set<String> names = Arrays.stream(ScheduleEditForm.class.getDeclaredFields())
                .map(java.lang.reflect.Field::getName).collect(Collectors.toSet());
        assertEquals(Set.of("doctorId", "workDate", "period", "startTime", "endTime", "totalNum"),
                names, "ScheduleEditForm 的字段集合应恰好是这六个");
    }

    /**
     * 历史排班可以改号源，但在已有预约时不能改时间；调整时段同样受限。
     *
     * <p>同时锁住 H1 的实现侧不变量：编辑路径<strong>不写 status</strong>。
     *
     * <p>注意这个断言依赖 MyBatis-Plus 默认的 {@code updateById} 跳过 null 列
     * （{@code FieldStrategy.NOT_NULL}）；真正的落库保证由
     * {@code tools/schedule_status_check.mjs} 端到端覆盖，这里只保证"实现没有主动设值"。
     * 契约形状由上一条 {@link #editFormHasNoStatusField} 锁住。
     */
    @Test
    void preserveLegacyScheduleOnEdit() {
        Service s = new Service();
        current = new DoctorSchedule();
        current.setId(9L);
        current.setDoctorId(1L);
        current.setPeriod(1);
        current.setWorkDate(LocalDate.now().minusDays(1));
        current.setStartTime(LocalTime.of(14, 0));
        current.setEndTime(LocalTime.of(16, 0));
        current.setStatus(0);

        ScheduleForm base = form(1, "14:00", "16:00");
        base.setWorkDate(current.getWorkDate());
        base.setTotalNum(25);
        ScheduleEditForm old = edit(base);
        for (long count : new long[]{0, 2}) {
            refs = count;
            s.update(9L, old);
            if (saved.getStatus() != null) {
                throw new AssertionError("编辑路径不应写 status，实际写了 " + saved.getStatus());
            }
            if (saved.getRemainNum() != 25 - count
                    || !saved.getStartTime().equals(current.getStartTime())) {
                throw new AssertionError("旧排班保存失败");
            }
        }
        old.setStartTime(LocalTime.of(9, 0));
        old.setEndTime(LocalTime.of(11, 0));
        reject(() -> s.update(9L, old), "条预约记录");
        refs = 0;
        s.update(9L, old);
        if (!saved.getStartTime().equals(LocalTime.of(9, 0))) {
            throw new AssertionError("修正时间失败");
        }
        old.setEndTime(LocalTime.of(13, 0));
        reject(() -> s.update(9L, old), "排班时间须在");
        old.setPeriod(2);
        old.setStartTime(LocalTime.of(9, 0));
        old.setEndTime(LocalTime.of(11, 0));
        reject(() -> s.update(9L, old), "排班时间须在");

        ScheduleBatchForm duplicate = batch(form(1, "09:00", "11:00"));
        duplicate.setPeriods(List.of(duplicate.getPeriods().get(0), duplicate.getPeriods().get(0)));
        reject(() -> s.batchCreate(duplicate), "每个时段只能配置一次");
    }

    /** 医生停诊期间仍可维护号源，但不能新开排班或恢复出诊；状态切换只走行内两个专用入口 */
    @Test
    void maintainStoppedDoctorSchedule() {
        Service s = new Service();
        current = new DoctorSchedule();
        current.setId(9L);
        current.setDoctorId(1L);
        current.setPeriod(1);
        current.setWorkDate(LocalDate.now().minusDays(1));
        current.setStartTime(LocalTime.of(14, 0));
        current.setEndTime(LocalTime.of(16, 0));
        current.setStatus(1);

        doctorStatus = 0;
        ScheduleForm base = form(1, "14:00", "16:00");
        base.setWorkDate(current.getWorkDate());
        base.setTotalNum(25);
        ScheduleEditForm maintenance = edit(base);
        s.update(9L, maintenance);
        if (saved.getTotalNum() != 25 || saved.getStatus() != null) {
            throw new AssertionError("停诊医生调整号源失败");
        }
        // 状态只能由专用入口翻：行内停诊写一次，编辑路径沿路不碰这一列
        s.stopClinic(9L);
        if (statusWrites != 1) {
            throw new AssertionError("行内停诊失败");
        }
        current.setStatus(0);
        s.update(9L, maintenance);
        if (saved.getStatus() != null) {
            throw new AssertionError("编辑路径不应写 status");
        }

        // 停诊中改容量可以，但恢复出诊只能走 resumeClinic，且要求医生仍在诊
        ScheduleForm restoreBase = form(1, "14:00", "16:00");
        restoreBase.setWorkDate(current.getWorkDate());
        ScheduleEditForm restore = edit(restoreBase);
        reject(() -> s.resumeClinic(9L), "该医生处于停诊状态");
        reject(() -> s.create(form(1, "09:00", "11:00")), "该医生处于停诊状态");
        reject(() -> s.batchCreate(batch(form(1, "09:00", "11:00"))), "该医生处于停诊状态");
        if (statusWrites != 1) {
            throw new AssertionError("停诊医生被恢复排班");
        }

        doctorStatus = 1;
        s.update(9L, restore);
        if (saved.getStatus() != null) {
            throw new AssertionError("编辑路径不应写 status");
        }
        s.resumeClinic(9L);
        if (statusWrites != 2) {
            throw new AssertionError("行内恢复失败");
        }
    }
}
