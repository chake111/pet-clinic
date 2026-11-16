package com.petclinic.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import com.petclinic.common.BatchLookup;
import com.petclinic.common.BizException;
import com.petclinic.common.PageResult;
import com.petclinic.dto.PageQuery;
import com.petclinic.dto.ScheduleBatchForm;
import com.petclinic.dto.ScheduleEditForm;
import com.petclinic.dto.ScheduleForm;
import com.petclinic.entity.Appointment;
import com.petclinic.entity.Department;
import com.petclinic.entity.Doctor;
import com.petclinic.entity.DoctorSchedule;
import com.petclinic.mapper.AppointmentMapper;
import com.petclinic.mapper.DepartmentMapper;
import com.petclinic.mapper.DoctorMapper;
import com.petclinic.mapper.DoctorScheduleMapper;
import com.petclinic.vo.ScheduleVo;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 排班与号源池。
 *
 * 号源的"扣减/回滚"本身在 AppointmentService 里通过
 * DoctorScheduleMapper#tryOccupy / #release 完成（单条 UPDATE 判影响行数，不引入 Redis）。
 * 这里只负责排班的录入与余量保护：任何改动都不允许把已占用的号源抹掉，
 * 否则会出现"订单在、号没了"或"号翻倍"的对不上账。
 */
@Service
@RequiredArgsConstructor
public class DoctorScheduleService extends ServiceImpl<DoctorScheduleMapper, DoctorSchedule> {

    private final DoctorMapper doctorMapper;
    private final AppointmentMapper appointmentMapper;
    private final DepartmentMapper departmentMapper;

    /** 用户端选号页：某位医生未来一段日期内可约的时段 */
    public List<ScheduleVo> listBookable(Long doctorId, LocalDate from, Integer days) {
        LocalDate start = from == null ? LocalDate.now() : from;
        int span = days == null ? 7 : Math.max(1, Math.min(days, 30));
        List<DoctorSchedule> rows = list(Wrappers.<DoctorSchedule>lambdaQuery()
                .eq(DoctorSchedule::getDoctorId, doctorId)
                .eq(DoctorSchedule::getStatus, 1)
                .ge(DoctorSchedule::getWorkDate, start)
                .le(DoctorSchedule::getWorkDate, start.plusDays(span - 1L))
                .orderByAsc(DoctorSchedule::getWorkDate)
                .orderByAsc(DoctorSchedule::getPeriod));
        Doctor doctor = doctorMapper.selectById(doctorId);
        Map<Long, Doctor> doctorDict = doctor == null ? Map.of() : Map.of(doctor.getId(), doctor);
        Map<Long, Department> deptDict = departmentsOf(doctorDict.values());
        return rows.stream().map(s -> toVo(s, doctorDict, deptDict)).collect(Collectors.toList());
    }

    public PageResult<ScheduleVo> pageAdmin(Long doctorId, LocalDate start, LocalDate end,
                                            Integer status, PageQuery query) {
        LambdaQueryWrapper<DoctorSchedule> qw = Wrappers.<DoctorSchedule>lambdaQuery()
                .eq(doctorId != null, DoctorSchedule::getDoctorId, doctorId)
                .ge(start != null, DoctorSchedule::getWorkDate, start)
                .le(end != null, DoctorSchedule::getWorkDate, end)
                .eq(status != null, DoctorSchedule::getStatus, status)
                .orderByDesc(DoctorSchedule::getWorkDate)
                .orderByAsc(DoctorSchedule::getPeriod)
                .orderByAsc(DoctorSchedule::getDoctorId);
        Page<DoctorSchedule> page = page(new Page<>(query.getPageNum(), query.getPageSize()), qw);
        Map<Long, Doctor> doctors = doctorsOf(page.getRecords());
        Map<Long, Department> depts = departmentsOf(doctors.values());
        Map<Long, Long> refs = refCounts(page.getRecords());
        return PageResult.of(page, s -> {
            ScheduleVo vo = toVo(s, doctors, depts);
            vo.setRefNum(refs.getOrDefault(s.getId(), 0L));
            return vo;
        });
    }

    @Transactional
    public DoctorSchedule create(ScheduleForm req) {
        requireSchedulable(req.getDoctorId());
        checkSlotSanity(req.getWorkDate(), req.getStartTime(), req.getEndTime());
        checkPeriodTime(req.getPeriod(), req.getStartTime(), req.getEndTime());
        if (exists(Wrappers.<DoctorSchedule>lambdaQuery()
                .eq(DoctorSchedule::getDoctorId, req.getDoctorId())
                .eq(DoctorSchedule::getWorkDate, req.getWorkDate())
                .eq(DoctorSchedule::getPeriod, req.getPeriod()))) {
            throw new BizException("该医生在这一天的这个时段已经排过班了");
        }
        DoctorSchedule s = new DoctorSchedule();
        s.setDoctorId(req.getDoctorId());
        s.setWorkDate(req.getWorkDate());
        s.setPeriod(req.getPeriod());
        s.setStartTime(req.getStartTime());
        s.setEndTime(req.getEndTime());
        s.setTotalNum(req.getTotalNum());
        s.setRemainNum(req.getTotalNum());
        s.setStatus(req.getStatus() == null ? 1 : req.getStatus());
        save(s);
        return s;
    }

    /**
     * 改排班（I10 之后分两类动作）：
     *
     * 1. 归属类字段——医生、日期、时段、起止时间：**只要有任何预约引用过这张排班（含已取消的单）就禁止改**。
     *    预约行上存的是下单时的快照（doctor_id / appointment_date / period / start_time / end_time），
     *    排班一旦被挪走，历史详情与真实号池就开始分叉，取消单也一样留着旧归属。
     *    要换医生或时间请另建时段，这张班只能停诊或改容量。
     * 2. 容量：允许调整，但占用量必须按最新值算。锁排班行之后再算占用——
     *    {@code total - remain} 的旧快照会被并发抢号甩在后面，直接拿它推占用量就能把别人刚抢到的号抹掉
     *    （跟踪表 I08/D1）。占用量以库里的有效预约条数为准（未取消、未逻辑删除），新总量不得小于它。
     *
     * 第 1 条的引用数同样在这把行锁之内统计，所以"校验通过后别人又下了一单"不成立：
     * 下单要先对同一行做 {@code tryOccupy} 的条件更新，那把排班行锁在我们释放之前拿不到。
     *
     * <p><strong>本方法不写 status</strong>：停诊与恢复只由 {@link #stopClinic} / {@link #resumeClinic}
     * 写入。入参 {@link ScheduleEditForm} 根本没有状态字段，所以一个停留很久的编辑弹窗再提交一次时，
     * 不会把期间发生的停诊静默撤销。原先 status 也从这条路径进库，两个写入口互相覆盖，
     * 管理员看到的是"点了停诊，过一会儿自己变回出诊"。
     *
     * 锁顺序：这里只锁 doctor_schedule，不锁任何 appointment——取消路径是
     * "先锁预约再退号"，反向加锁会成环（Task 4 实测的 1213 就是这么来的）。
     * 统计预约用普通一致性读，所有改动都在这把行锁之内。
     */
    @Transactional
    public void update(Long id, ScheduleEditForm req) {
        DoctorSchedule cur = baseMapper.selectByIdForUpdate(id);
        if (cur == null) {
            throw BizException.notFound("排班");
        }
        // 日期校验只在"换了日期"时做：历史排班调容量、改停诊状态不能被"不能给过去日期排班"挡住
        if (!cur.getWorkDate().equals(req.getWorkDate())) {
            if (req.getWorkDate() == null) {
                throw new BizException("请选择排班日期");
            }
            checkDateNotPast(req.getWorkDate());
        }
        checkTimeOrder(req.getStartTime(), req.getEndTime());
        checkPeriod(req.getPeriod());
        boolean sameSlot = cur.getDoctorId().equals(req.getDoctorId())
                && cur.getWorkDate().equals(req.getWorkDate())
                && cur.getPeriod().equals(req.getPeriod());
        if (!sameSlot && exists(Wrappers.<DoctorSchedule>lambdaQuery()
                .eq(DoctorSchedule::getDoctorId, req.getDoctorId())
                .eq(DoctorSchedule::getWorkDate, req.getWorkDate())
                .eq(DoctorSchedule::getPeriod, req.getPeriod())
                .ne(DoctorSchedule::getId, id))) {
            throw new BizException("该医生在这一天的这个时段已经排过班了");
        }
        long refs = referencedById(id);
        boolean movesAttribution = !sameSlot
                || !Objects.equals(cur.getStartTime(), req.getStartTime())
                || !Objects.equals(cur.getEndTime(), req.getEndTime());
        if (refs > 0 && movesAttribution) {
            throw new BizException("该时段已有 " + refs + " 条预约记录（含已取消），不能改医生、日期或时段，"
                    + "请另建时段；号源总数仍可调整");
        }
        // 只有挪归属要医生在诊；改容量（含停诊中的排班）只要医生档案还在
        if (movesAttribution) {
            requireSchedulable(req.getDoctorId());
        } else {
            requireDoctor(req.getDoctorId());
        }
        // 旧排班保留原时间；改时段或起止时间才执行新范围校验。
        if (!Objects.equals(cur.getPeriod(), req.getPeriod())
                || !Objects.equals(cur.getStartTime(), req.getStartTime())
                || !Objects.equals(cur.getEndTime(), req.getEndTime())) {
            checkPeriodTime(req.getPeriod(), req.getStartTime(), req.getEndTime());
        }

        int booked = appointmentMapper.selectCount(Wrappers.<Appointment>lambdaQuery()
                .eq(Appointment::getScheduleId, id)
                .ne(Appointment::getStatus, Appointment.ST_CANCELLED)).intValue();
        if (req.getTotalNum() < booked) {
            throw new BizException("该时段已有 " + booked + " 个有效预约，总量不能改到 " + booked + " 以下");
        }

        DoctorSchedule s = new DoctorSchedule();
        s.setId(id);
        s.setDoctorId(req.getDoctorId());
        s.setWorkDate(req.getWorkDate());
        s.setPeriod(req.getPeriod());
        s.setStartTime(req.getStartTime());
        s.setEndTime(req.getEndTime());
        s.setTotalNum(req.getTotalNum());
        s.setRemainNum(req.getTotalNum() - booked);
        // 不 setStatus：状态列不在这条路径的写入范围内（见方法注释）
        updateById(s);
    }

    /**
     * 按星期模板批量生成排班，保留已有排班及其号源。
     *
     * @param req 批量模板；仅处理日期范围内今天及以后、且匹配 weekDays 的日期，
     *            已存在的医生、日期、时段组合计入 skipped
     * @return 新建条数与已有组合的跳过次数；日期筛选未命中的日期不计入 skipped
     */
    @Transactional
    public BatchSummary batchCreate(ScheduleBatchForm req) {
        requireSchedulable(req.getDoctorId());
        if (req.getStartDate().isAfter(req.getEndDate())) {
            throw new BizException("开始日期不能晚于结束日期");
        }
        long span = req.getEndDate().toEpochDay() - req.getStartDate().toEpochDay() + 1;
        if (span > 90) {
            throw new BizException("一次最多批量排 90 天");
        }
        Set<Integer> periods = new HashSet<>();
        for (ScheduleBatchForm.PeriodTemplate t : req.getPeriods()) {
            checkPeriodTime(t.getPeriod(), t.getStartTime(), t.getEndTime());
            if (!periods.add(t.getPeriod())) {
                throw new BizException("每个时段只能配置一次");
            }
        }

        Set<Integer> weekDays = Set.copyOf(req.getWeekDays());
        List<DoctorSchedule> pending = new ArrayList<>();
        int skipped = 0;
        for (LocalDate d = req.getStartDate(); !d.isAfter(req.getEndDate()); d = d.plusDays(1)) {
            if (d.isBefore(LocalDate.now())) {
                continue;
            }
            if (!weekDays.contains(d.getDayOfWeek().getValue())) {
                continue;
            }
            for (ScheduleBatchForm.PeriodTemplate t : req.getPeriods()) {
                if (exists(Wrappers.<DoctorSchedule>lambdaQuery()
                        .eq(DoctorSchedule::getDoctorId, req.getDoctorId())
                        .eq(DoctorSchedule::getWorkDate, d)
                        .eq(DoctorSchedule::getPeriod, t.getPeriod()))) {
                    skipped++;
                    continue;
                }
                DoctorSchedule s = new DoctorSchedule();
                s.setDoctorId(req.getDoctorId());
                s.setWorkDate(d);
                s.setPeriod(t.getPeriod());
                s.setStartTime(t.getStartTime());
                s.setEndTime(t.getEndTime());
                int total = req.getOverrideTotalNum() == null ? t.getTotalNum() : req.getOverrideTotalNum();
                s.setTotalNum(total);
                s.setRemainNum(total);
                s.setStatus(1);
                pending.add(s);
            }
        }
        if (!pending.isEmpty()) {
            saveBatch(pending);
        }
        return new BatchSummary(pending.size(), skipped);
    }

    /**
     * 删除排班前，在排班行锁内统计有效预约引用；存在引用时拒绝删除，可改为停诊。
     *
     * @param id 排班 ID；引用统计包含已取消预约，仅统计 deleted=0 的预约
     */
    @Transactional
    public void remove(Long id) {
        if (baseMapper.selectByIdForUpdate(id) == null) {
            throw BizException.notFound("排班");
        }
        long refs = referencedById(id);
        if (refs > 0) {
            throw new BizException("该时段已有 " + refs + " 条预约记录（含已取消），不能删除，请改为停诊保留历史");
        }
        removeById(id);
    }

    /**
     * 统计排班的预约引用，供修改归属和删除前校验。
     *
     * @param scheduleId 排班 ID
     * @return deleted=0 的预约条数，包含已取消预约；逻辑删除条件由 MyBatis-Plus 添加
     */
    private long referencedById(Long scheduleId) {
        return appointmentMapper.selectCount(Wrappers.<Appointment>lambdaQuery()
                .eq(Appointment::getScheduleId, scheduleId));
    }

    /**
     * 停诊（R6）：只关可预约状态，不动余量。
     * 已成交的订单保持原样，由前台线下联系改约——这是单店场景下最简单的收敛方式。
     * 之前这里会把 remain_num 一并清零、恢复时再按存活订单重算，页面就分不出
     * "真余量"和"停诊清零"（跟踪表 I07/D2）；余量是事实，不该被一个状态开关改写。
     *
     * <p>状态列<strong>只</strong>在这里和 {@link #resumeClinic} 写入：编辑接口
     * {@link #update} 的入参不含 status，避免旧的编辑表单把停诊覆盖回去。
     *
     * <p>这里用 <code>require</code>（普通读）确认存在，互斥靠 UPDATE 自身的行锁——
     * 不是 <code>selectByIdForUpdate</code>。窄窗口下若记录刚被并发删除，
     * UPDATE 影响 0 行，此时抛 404，不把"没改到"报成"已停诊"。
     */
    @Transactional
    public void stopClinic(Long id) {
        require(id);
        boolean changed = update(Wrappers.<DoctorSchedule>lambdaUpdate()
                .set(DoctorSchedule::getStatus, 0)
                .eq(DoctorSchedule::getId, id));
        if (!changed) {
            throw BizException.notFound("排班");
        }
    }

    /**
     * 恢复出诊（R6）：只把状态打开，余量原样保留。
     * 停诊期间发生的取消会照常走 release 退回余量，所以这里不需要、也不允许重算。
     *
     * <p>同样靠 UPDATE 自身的行锁做互斥，改了 0 行（被并发删除）时抛 404。
     */
    @Transactional
    public void resumeClinic(Long id) {
        DoctorSchedule s = require(id);
        requireSchedulable(s.getDoctorId());
        boolean changed = update(Wrappers.<DoctorSchedule>lambdaUpdate()
                .set(DoctorSchedule::getStatus, 1)
                .eq(DoctorSchedule::getId, id));
        if (!changed) {
            throw BizException.notFound("排班");
        }
    }

    public DoctorSchedule require(Long id) {
        DoctorSchedule s = getById(id);
        if (s == null) {
            throw BizException.notFound("排班");
        }
        return s;
    }

    private Doctor requireDoctor(Long doctorId) {
        Doctor d = doctorMapper.selectById(doctorId);
        if (d == null) {
            throw BizException.notFound("医生");
        }
        return d;
    }

    /** 新建、调整出诊安排或恢复排班时，医生须正常出诊。 */
    private void requireSchedulable(Long doctorId) {
        if (requireDoctor(doctorId).getStatus() != 1) {
            throw new BizException("该医生处于停诊状态，请先在医生管理里恢复出诊再排班");
        }
    }

    private void checkPeriod(Integer period) {
        if (period == null || period < 1 || period > 3) {
            throw new BizException("时段只能是 1 上午 / 2 下午 / 3 夜间");
        }
    }

    private void checkSlotSanity(LocalDate workDate, LocalTime start, LocalTime end) {
        if (workDate == null) {
            throw new BizException("请选择排班日期");
        }
        checkDateNotPast(workDate);
        checkTimeOrder(start, end);
    }

    private void checkPeriodTime(Integer period, LocalTime start, LocalTime end) {
        checkPeriod(period);
        checkTimeOrder(start, end);
        LocalTime min = LocalTime.of(switch (period) { case 1 -> 8; case 2 -> 13; default -> 18; }, 0);
        LocalTime max = LocalTime.of(switch (period) { case 1 -> 12; case 2 -> 18; default -> 22; }, 0);
        if (start.isBefore(min) || end.isAfter(max)) {
            String label = switch (period) { case 1 -> "上午"; case 2 -> "下午"; default -> "夜间"; };
            throw new BizException(label + "排班时间须在 " + min + "–" + max + " 内");
        }
    }

    /** 只有"新建"或"把排班挪到别的日期"才要求日期不在过去（I10：历史排班仍要能调容量） */
    private void checkDateNotPast(LocalDate workDate) {
        if (workDate.isBefore(LocalDate.now())) {
            throw new BizException("不能给过去的日期排班");
        }
    }

    private void checkTimeOrder(LocalTime start, LocalTime end) {
        if (start == null || end == null || !start.isBefore(end)) {
            throw new BizException("结束时间必须晚于开始时间");
        }
    }

    /** 一页排班的引用数（含已取消预约），一次分组查询，别按行查 */
    private Map<Long, Long> refCounts(List<DoctorSchedule> rows) {
        List<Long> ids = rows.stream().map(DoctorSchedule::getId)
                .filter(Objects::nonNull).distinct().collect(Collectors.toList());
        if (ids.isEmpty()) {
            return Map.of();
        }
        return appointmentMapper.selectMaps(Wrappers.<Appointment>query()
                        .select("schedule_id AS scheduleId", "COUNT(*) AS num")
                        .in("schedule_id", ids)
                        .groupBy("schedule_id"))
                .stream().filter(m -> m.get("scheduleId") != null)
                .collect(Collectors.toMap(
                        m -> ((Number) m.get("scheduleId")).longValue(),
                        m -> ((Number) m.get("num")).longValue()));
    }

    private Map<Long, Doctor> doctorsOf(List<DoctorSchedule> rows) {
        return BatchLookup.mapByIds(doctorMapper::selectBatchIds,
                BatchLookup.ids(rows, DoctorSchedule::getDoctorId), Doctor::getId);
    }

    private ScheduleVo toVo(DoctorSchedule s, Map<Long, Doctor> doctorDict, Map<Long, Department> deptDict) {
        ScheduleVo vo = new ScheduleVo();
        BeanUtils.copyProperties(s, vo);
        Doctor d = doctorDict.get(s.getDoctorId());
        if (d == null) {
            vo.setDoctorAvailable(false);
            return vo;
        }
        vo.setDoctorName(d.getName());
        vo.setDoctorTitle(d.getTitle());
        vo.setDoctorAvatar(d.getAvatar());
        vo.setDepartmentId(d.getDepartmentId());
        vo.setConsultationFee(d.getConsultationFee());
        vo.setDoctorAvailable(d.getStatus() == 1);
        Department dept = deptDict.get(d.getDepartmentId());
        if (dept != null) {
            vo.setDepartmentName(dept.getName());
        }
        return vo;
    }

    /** 按医生行上挂的 departmentId 批量取科室，避免每行一次查询 */
    private Map<Long, Department> departmentsOf(Collection<Doctor> doctors) {
        return BatchLookup.mapByIds(departmentMapper::selectBatchIds,
                BatchLookup.ids(doctors, Doctor::getDepartmentId), Department::getId);
    }

    /** 批量排班的回执：新建多少条、跳过多少条已存在的 */
    public record BatchSummary(int created, int skipped) {
    }
}
