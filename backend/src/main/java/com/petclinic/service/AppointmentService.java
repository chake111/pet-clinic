package com.petclinic.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import com.petclinic.common.BizException;
import com.petclinic.common.BatchLookup;
import com.petclinic.common.PageResult;
import com.petclinic.config.AppProperties;
import com.petclinic.dto.AppointmentForm;
import com.petclinic.dto.AppointmentQuery;
import com.petclinic.dto.PageQuery;
import com.petclinic.entity.*;
import com.petclinic.mapper.*;
import com.petclinic.security.LoginUser;
import com.petclinic.security.UserContext;
import com.petclinic.vo.AppointmentVo;
import com.petclinic.vo.PetDisplayVo;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.BeanUtils;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.ThreadLocalRandom;
import java.util.regex.Pattern;

/**
 * 预约订单：本系统的核心状态机。只面向到院门诊——图文问诊免费、不建订单，
 * 会话直接在 consult_session 上建（见 ConsultService）。
 *
 * 状态：0 待接诊 -> 1 已接诊 -> 2 已完成；只有 0 可取消 -> 3 已取消（R5）；过期未支付 -> 3（系统）；
 * 已支付却过就诊日仍未接诊 -> 4 未到诊（R3，已接诊不改判、未到诊不退号不退款）。
 *
 * 号源守恒是这里最要紧的不变量：doctor_schedule.remain_num 减一 与 appointment 落库
 * 必须在同一个事务里，取消/退款时的加回也一样。扣号走 tryOccupy 的单条 UPDATE，
 * 由 InnoDB 行锁 + 影响行数判定成败，所以不引入 Redis 也不会超卖。
 *
 * 契约动机: 扣号建单一致性——两步不在同一事务就会留下"扣了号没单、有单没扣号"的半截状态；
 * 重复退号防护——退号挂在条件更新的影响行数上，取消与超时清扫两条入口各只可能改到一次行。
 *
 * 排队序号与容量是两件事：remain_num 表示还能约几个，last_queue_no 表示这个排班发到过几号。
 * 取消只把前者加回去，后者不回退，所以同一个号不会发给两个人，代价是序号允许有空缺。
 *
 * 并发保护只有一条路径：改一张已有预约的状态，必须先 selectByIdForUpdate 锁住它，
 * 在锁内重判归属与当前状态，再带条件更新，最后才退号。锁外读到的对象只能用来预检，
 * 不能作为放行依据——两条并发取消各自读到"待接诊"就会各退一次号。
 * 锁顺序固定为：处理已有预约时先锁 appointment 再更新 doctor_schedule；
 * 下单只锁 doctor_schedule 再插入 appointment。没有反向顺序，因此不会成环。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AppointmentService extends ServiceImpl<AppointmentMapper, Appointment> {

    // 到毫秒再补 8 位随机：同一毫秒内仍可能有多笔下单同时落库，4 位随机（1 万种）
    // 在 100 并发的抢号场景下会撞 uk_order_no，重复键被转成 400"数据已存在"，
    // 让"恰好 N 单成功"这类断言变得 flaky。8 位随机把碰撞概率压到可忽略；
    // PC + 17 位时间 + 8 位随机 = 27 字符，order_no VARCHAR(32) 放得下。
    private static final DateTimeFormatter NO_STAMP = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS");

    // 客户端生成的不透明键：只允许 URL/头值安全的可打印字符，长度 8–64 与列宽对齐。
    // 收紧格式是为了让"脏键"在下单入口就报 400，而不是落库后因截断/排序规则差异产生诡异重放。
    private static final Pattern IDEM_KEY = Pattern.compile("[A-Za-z0-9._:-]{8,64}");

    private final PetService petService;
    private final PetMapper petMapper;
    private final DoctorMapper doctorMapper;
    private final DepartmentMapper departmentMapper;
    private final DoctorScheduleMapper scheduleMapper;
    private final SysUserMapper sysUserMapper;
    private final ConsultSessionMapper sessionMapper;
    private final MedicalRecordMapper recordMapper;
    private final AppProperties props;
    private final PlatformTransactionManager txManager;

    // ---------------------------------------------------------------- 下单

    /** 无幂等键的旧入口，行为与改造前一致 */
    public AppointmentVo create(AppointmentForm req) {
        return create(req, null);
    }

    /**
     * 带幂等键的下单。
     *
     * <p>幂等键只解决"客户端重试不要多落单"：事务外先按 (userId, key) 回读一次，
     * 命中就原样返回；事务内拿到排班行锁后再查一次，作为并发同键的权威判定。
     * 锁外的预查只是重试快路径——它让"时段已过期/已停诊/排班已删"的重试仍能拿到原单，
     * 而不是先被校验拦下报错。
     *
     * <p>这里不能用 @Transactional 包整个方法：同类内 create(req) 自调用不走代理，
     * 而且唯一键冲突必须先随事务回滚（扣号与 last_queue_no 一起退回）之后，
     * 才能在事务外重新读到冲突方已提交的原单。事务边界交给 TransactionTemplate。
     */
    public AppointmentVo create(AppointmentForm req, String idemKey) {
        String key = normalizeIdemKey(idemKey);
        // 键非空才需要当前用户；无键路径仍由 petService.requireOwned 做登录与归属校验，
        // 保持原有调用顺序与 401/404 语义不变。
        Long userId = key == null ? null : UserContext.requireId();
        if (key != null) {
            Appointment existing = baseMapper.selectByUserAndIdemKey(userId, key);
            if (existing != null) {
                return replayOf(existing, req);
            }
        }

        TransactionTemplate tx = new TransactionTemplate(txManager);
        // READ_COMMITTED：排班锁串行化下单后，这里必须看得见前一个请求刚提交的预约，
        // 否则锁内幂等回读与"同宠物同时段"校验都会读到旧快照。
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        try {
            return tx.execute(status -> doCreate(req, key, userId));
        } catch (DuplicateKeyException e) {
            if (key == null) {
                throw e;
            }
            // 事务已经回滚（扣号与 last_queue_no 一并退回），此时才读得到冲突方提交的原单。
            Appointment existing = baseMapper.selectByUserAndIdemKey(userId, key);
            if (existing == null) {
                // 撞的是 uk_order_no（27 位随机串重复），与幂等键无关，按原语义抛出
                throw e;
            }
            log.warn("下单唯一键冲突命中幂等键，回读原单：user={} key={} appointment={}",
                    userId, key, existing.getId());
            return replayOf(existing, req);
        }
    }

    /** 下单主体。key 为 null 时与改造前完全一致。 */
    private AppointmentVo doCreate(AppointmentForm req, String key, Long userId) {
        Pet pet = petService.requireOwned(req.getPetId());
        Doctor doctor = doctorMapper.selectById(req.getDoctorId());
        if (doctor == null) {
            throw BizException.notFound("医生");
        }
        if (doctor.getStatus() != 1) {
            throw new BizException("该医生已停诊，请改约其他医生");
        }
        if (req.getSymptom() == null || req.getSymptom().isBlank()) {
            throw new BizException("请描述症状");
        }
        // 下单第一件事是把排班行锁住再读。锁外的快照读会给出可触发的交错：
        // 用户读到旧医生/旧日期 → 管理员锁行、确认"还没有预约引用"、改归属并提交 → 用户扣号成功，
        // 却把先前读到的旧信息写进预约，快照与归属再次分叉（I10 的另一半）。
        // 同一条锁读也挡住"给刚被删掉的排班继续扣号"：删行是物理 DELETE，读不到就是不存在。
        // 锁顺序仍是"下单只锁排班、再插预约"，与取消路径（先锁预约再退号）同向，不会成环。
        DoctorSchedule sch = scheduleMapper.selectByIdForUpdate(req.getScheduleId());
        // 拿到排班行锁后先做幂等回读：并发同键的请求都在这把锁上排队，
        // 第一个提交后，后面每个都会在这里看到原单，不会重复扣号。
        if (key != null) {
            Appointment existing = baseMapper.selectByUserAndIdemKey(userId, key);
            if (existing != null) {
                return replayOf(existing, req);
            }
        }
        if (sch == null) {
            throw BizException.notFound("排班时段");
        }
        if (!sch.getDoctorId().equals(req.getDoctorId())) {
            throw new BizException("所选时段不属于该医生");
        }
        if (sch.getStatus() != 1) {
            throw new BizException("该时段已停诊，请换个时间");
        }
        requireNotPast(sch);

        // 排班锁串行化下单；READ_COMMITTED 保证这里看见前一个请求刚提交的预约。
        if (count(Wrappers.<Appointment>lambdaQuery()
                .eq(Appointment::getPetId, pet.getId())
                .eq(Appointment::getScheduleId, sch.getId())
                .ne(Appointment::getStatus, Appointment.ST_CANCELLED)) > 0) {
            throw new BizException("该宠物已预约此时段，请在我的预约中查看");
        }

        Appointment a = new Appointment();
        a.setOrderNo(nextOrderNo());
        a.setIdemKey(key);
        a.setUserId(pet.getUserId());
        a.setPetId(pet.getId());
        a.setDoctorId(doctor.getId());
        a.setDepartmentId(doctor.getDepartmentId());
        a.setConsultType(Appointment.CT_VISIT);
        a.setScheduleId(sch.getId());
        a.setAppointmentDate(sch.getWorkDate());
        a.setPeriod(sch.getPeriod());
        a.setStartTime(sch.getStartTime());
        a.setEndTime(sch.getEndTime());
        a.setSymptom(req.getSymptom().trim());
        a.setImages(blankToNull(req.getImages()));
        DoctorService.requireFee(doctor.getConsultationFee());
        a.setAmount(doctor.getConsultationFee());
        a.setPayStatus(Appointment.PAY_NONE);
        a.setStatus(Appointment.ST_PENDING);
        a.setIsReviewed(0);
        // 扣号放在写单之前：影响行数为 0 说明别人刚抢走最后一个号
        if (scheduleMapper.tryOccupy(sch.getId()) == 0) {
            throw new BizException("该时段号源已约满，请换个时间");
        }
        // 序号来自占号时一并递增的计数器，不再由「总量 - 余量」推算：取消把余量退回去，
        // 推算值就会回退成已经发过的号。当前读也不能省——selectById 走事务快照，
        // 在 REPEATABLE READ 下可能读到递增前的值。预约落库失败会整体回滚，
        // 容量和计数器一起退回，不会留下只扣一半的状态。
        Integer queueNo = scheduleMapper.selectLastQueueNoForUpdate(sch.getId());
        if (queueNo == null) {
            throw new BizException("号源状态异常，请稍后重试");
        }
        a.setQueueNo(queueNo);
        save(a);
        return detailOf(a, false);
    }

    // ---------------------------------------------------------------- 支付 / 取消

    /** 模拟支付：更新状态 */
    @Transactional
    public AppointmentVo pay(Long id) {
        Appointment a = lockOwned(id);
        if (a.getStatus() != Appointment.ST_PENDING) {
            throw new BizException("当前状态不能支付");
        }
        if (Integer.valueOf(Appointment.PAY_PAID).equals(a.getPayStatus())) {
            return detailOf(a, false);
        }
        if (isPayExpired(a)) {
            throw new BizException("订单已超过 " + props.getPayTimeoutMinutes() + " 分钟未支付，请重新预约");
        }
        // 同一时刻只取一次：写库与回填响应必须一致，否则响应里的 payTime 会和库里有毫秒级偏差。
        LocalDateTime now = LocalDateTime.now();
        if (baseMapper.update(null, Wrappers.<Appointment>lambdaUpdate()
                .set(Appointment::getPayStatus, Appointment.PAY_PAID)
                .set(Appointment::getPayTime, now)
                .set(Appointment::getPayType, "MOCK")
                .eq(Appointment::getId, id)
                .eq(Appointment::getStatus, Appointment.ST_PENDING)
                .eq(Appointment::getPayStatus, Appointment.PAY_NONE)) == 0) {
            throw new BizException("订单状态已变化，请刷新后重试");
        }
        a.setPayStatus(Appointment.PAY_PAID);
        a.setPayTime(now);
        a.setPayType("MOCK");
        return detailOf(a, false);
    }

    /** 用户取消。已支付的单子把号源退回池子，支付状态改成已退款 */
    @Transactional(noRollbackFor = VisitOverdueException.class)
    public void cancelByUser(Long id, String reason) {
        cancelLocked(lockOwned(id), blankToNull(reason), "USER");
    }

    /** 医生/管理员替患者取消（到院爽约、临时停诊等） */
    @Transactional(noRollbackFor = VisitOverdueException.class)
    public void cancelByStaff(Long id, String reason) {
        Appointment a = lockForUpdate(id);
        requireStaffMayTouch(a);
        cancelLocked(a, blankToNull(reason), UserContext.require().isDoctor() ? "DOCTOR" : "ADMIN");
    }

    /**
     * 取消的唯一出口（R5：只有待接诊可以取消）。入参必须是刚锁到的行，不是快照。
     * 用户、责任医生、管理员三条入口都走这里，收紧一处即三处同时生效。
     * 已接诊不经这个接口退款退号，本轮也不新增"接诊后异常退款"流程——
     * 真发生纠纷时由线下处理，不留一条自动退钱的口子。
     *
     * 退号挂在条件更新的影响行数上：改到 1 行才 release，
     * 所以"一次取消只退一次号"来自这里只可能改到一次，而不是靠 release 里的 LEAST 封顶。
     */
    private void cancelLocked(Appointment a, String reason, String by) {
        requireVisitNotOverdue(a);
        if (a.getStatus() == Appointment.ST_CANCELLED) {
            throw new BizException("该预约已取消");
        }
        if (a.getStatus() != Appointment.ST_PENDING) {
            throw new BizException("已进入接诊流程，无法取消，请联系前台处理");
        }
        if (baseMapper.update(null, Wrappers.<Appointment>lambdaUpdate()
                .set(Appointment::getStatus, Appointment.ST_CANCELLED)
                .set(Appointment::getCancelReason, reason)
                .set(Appointment::getCancelBy, by)
                .set(Appointment::getCancelTime, LocalDateTime.now())
                .set(Integer.valueOf(Appointment.PAY_PAID).equals(a.getPayStatus()),
                        Appointment::getPayStatus, Appointment.PAY_REFUNDED)
                .eq(Appointment::getId, a.getId())
                .eq(Appointment::getStatus, Appointment.ST_PENDING)) == 0) {
            throw new BizException("该预约已取消");
        }
        if (a.getScheduleId() != null) {
            scheduleMapper.release(a.getScheduleId());
        }
    }

    // ---------------------------------------------------------------- 接诊 / 完成

    @Transactional(noRollbackFor = VisitOverdueException.class)
    public void accept(Long id) {
        Appointment a = lockForUpdate(id);
        requireDoctorMayTouch(a);
        requireVisitNotOverdue(a);
        if (a.getStatus() != Appointment.ST_PENDING) {
            throw new BizException("只有待接诊的预约可以接诊");
        }
        if (!Integer.valueOf(Appointment.PAY_PAID).equals(a.getPayStatus())) {
            throw new BizException("患者尚未支付，不能开始接诊");
        }
        if (baseMapper.update(null, Wrappers.<Appointment>lambdaUpdate()
                .set(Appointment::getStatus, Appointment.ST_ACCEPTED)
                .set(Appointment::getAcceptTime, LocalDateTime.now())
                .eq(Appointment::getId, id)
                .eq(Appointment::getStatus, Appointment.ST_PENDING)) == 0) {
            throw new BizException("该预约状态已变化，请刷新后重试");
        }
    }

    /** 结束就诊。病历是独立接口，医生可以在结束前或结束后补写，所以这里不强制病历已存在 */
    @Transactional
    public void finish(Long id) {
        Appointment a = lockForUpdate(id);
        requireDoctorMayTouch(a);
        if (a.getStatus() != Appointment.ST_ACCEPTED) {
            throw new BizException("请先接诊再结束");
        }
        if (baseMapper.update(null, Wrappers.<Appointment>lambdaUpdate()
                .set(Appointment::getStatus, Appointment.ST_FINISHED)
                .set(Appointment::getFinishTime, LocalDateTime.now())
                .eq(Appointment::getId, id)
                .eq(Appointment::getStatus, Appointment.ST_ACCEPTED)) == 0) {
            throw new BizException("该预约状态已变化，请刷新后重试");
        }
        doctorMapper.incrementAppointmentCount(a.getDoctorId());
    }

    // ---------------------------------------------------------------- 查询

    /** 我的预约（用户端） */
    public PageResult<AppointmentVo> pageMine(Integer status, PageQuery q) {
        LambdaQueryWrapper<Appointment> qw = Wrappers.<Appointment>lambdaQuery()
                .eq(Appointment::getUserId, UserContext.requireId())
                .eq(status != null, Appointment::getStatus, status)
                .orderByDesc(Appointment::getCreateTime);
        return voPage(page(new Page<>(q.getPageNum(), q.getPageSize()), qw), false);
    }

    /** 后台用户详情用：某用户的最近预约（带患者侧信息，与工作台同一口径） */
    public List<AppointmentVo> listByUserForAdmin(Long userId, int limit) {
        List<Appointment> rows = list(Wrappers.<Appointment>lambdaQuery()
                .eq(Appointment::getUserId, userId)
                .orderByDesc(Appointment::getCreateTime)
                .last("LIMIT " + Math.max(1, Math.min(limit, 100))));
        return buildVos(rows, true);
    }

    /**
     * 后台/医生工作台的订单列表。医生账号只能看到自己的单，
     * 入参 doctorId 对医生账号无效——否则改个 query 参数就能翻别人的接诊单。
     */
    public PageResult<AppointmentVo> pageForStaff(AppointmentQuery q) {
        LoginUser u = UserContext.require();
        Long doctorId = u.isDoctor() ? UserContext.requireDoctorId() : q.getDoctorId();
        LocalDate start = q.getDay() != null ? q.getDay() : q.getStart();
        LocalDate end = q.getDay() != null ? q.getDay() : q.getEnd();
        LambdaQueryWrapper<Appointment> qw = Wrappers.<Appointment>lambdaQuery()
                .eq(doctorId != null, Appointment::getDoctorId, doctorId)
                .eq(q.getUserId() != null, Appointment::getUserId, q.getUserId())
                .eq(q.getStatus() != null, Appointment::getStatus, q.getStatus())
                .eq(q.getPayStatus() != null, Appointment::getPayStatus, q.getPayStatus())
                .ge(start != null, Appointment::getAppointmentDate, start)
                .le(end != null, Appointment::getAppointmentDate, end)
                .orderByDesc(Appointment::getAppointmentDate)
                .orderByAsc(Appointment::getPeriod)
                .orderByAsc(Appointment::getQueueNo);
        return voPage(page(new Page<>(q.getPageNum(), q.getPageSize()), qw), true);
    }

    public AppointmentVo detail(Long id) {
        Appointment a = requireExists(id);
        LoginUser u = UserContext.require();
        if (u.isClient()) {
            // 和 pay/cancel 走同一套口径：别人的单一律"不存在"，不给出可枚举的探测信号
            if (!a.getUserId().equals(u.getId())) {
                throw BizException.notFound("预约记录");
            }
            return detailOf(a, false);
        }
        if (u.isDoctor() && !a.getDoctorId().equals(u.getDoctorId())) {
            throw BizException.forbidden("只能查看自己接诊的单子");
        }
        return detailOf(a, true);
    }

    public Appointment requireMine(Long id) {
        Appointment a = requireExists(id);
        if (!a.getUserId().equals(UserContext.requireId())) {
            throw BizException.notFound("预约记录");
        }
        return a;
    }

    public Appointment requireExists(Long id) {
        Appointment a = getById(id);
        if (a == null) {
            throw BizException.notFound("预约记录");
        }
        return a;
    }

    /** 锁内重读。状态判定一律以返回的对象为准，查不到就是不存在或已逻辑删除。 */
    private Appointment lockForUpdate(Long id) {
        Appointment a = baseMapper.selectByIdForUpdate(id);
        if (a == null) {
            throw BizException.notFound("预约记录");
        }
        return a;
    }

    /**
     * 给下游写入（病历首次落库等）复用的锁：先锁预约行，再按返回值判状态与归属。
     * 病历"先查有没有、没有再插"这两步之间必须持有这把行锁，否则两个并发请求
     * 会各自查空、各自插入，留下同一预约两份有效病历（跟踪表 I09/M2）。
     * 锁顺序仍是"预约在前"，与取消、退号同向，不会成环。
     */
    @Transactional
    public Appointment lockForWrite(Long id) {
        return lockForUpdate(id);
    }

    /** 用户端入口用：先锁行，再按归属判"不存在"，不给可枚举的探测信号。 */
    private Appointment lockOwned(Long id) {
        Appointment a = lockForUpdate(id);
        if (!a.getUserId().equals(UserContext.requireId())) {
            throw BizException.notFound("预约记录");
        }
        return a;
    }

    /** 提交评价成功后回写"已评价"，避免一单多评 */
    public void markReviewed(Long appointmentId) {
        update(Wrappers.<Appointment>lambdaUpdate()
                .set(Appointment::getIsReviewed, 1)
                .eq(Appointment::getId, appointmentId));
    }

    // ---------------------------------------------------------------- 定时清扫
    //
    // 清扫的循环放在 AppointmentSweepTask 里，一张单一个事务（task 通过注入的 service 代理
    // 调用，事务边界才生效；同类内互相调用 @Transactional 方法不会开新事务）。
    // 这不是风格问题：整批共用一个事务时，清扫会一边持有已处理单的排班行锁、
    // 一边继续去锁下一张预约，与"用户取消先锁预约再退号"的顺序相反，
    // 实测就是死锁 1213（.tmp/t2c/t4-01/backend-8082.log，用户取消对外变成 500）。
    // 逐单事务后每个事务最多同时持有一张预约行 + 一行排班，锁顺序全程一致。

    /** 超时未支付的候选 id。只取 id、按 id 稳定排序，判定留到锁内重做。 */
    public List<Long> unpaidOverdueIds() {
        return baseMapper.selectUnpaidOverdueIds(
                LocalDateTime.now().minusMinutes(props.getPayTimeoutMinutes()));
    }

    /**
     * 取消一张超时未支付的单。调用方必须已经在事务外确认过它过期，这里只负责锁内复核：
     * 扫到取消之间它可能已被用户取消、已被支付、或刚好没到期，不复核就会重复退号。
     *
     * @param id 待复核的预约 ID
     * @return 本次取消成功时为 true；预约不存在、非待接诊、非未支付或尚未超时时为 false
     */
    @Transactional
    public boolean expireOne(Long id) {
        Appointment a = baseMapper.selectByIdForUpdate(id);
        if (a == null || a.getStatus() != Appointment.ST_PENDING
                || !Integer.valueOf(Appointment.PAY_NONE).equals(a.getPayStatus())
                || !isPayExpired(a)) {
            return false;
        }
        cancelLocked(a, "超过 " + props.getPayTimeoutMinutes() + " 分钟未支付，系统自动取消", "SYSTEM");
        return true;
    }

    /** 过就诊日仍挂在待接诊且已支付的候选 id（R3：已接诊与未支付都不在此列） */
    public List<Long> staleVisitIds() {
        return baseMapper.selectStaleVisitIds();
    }

    /**
     * 把一张"已支付却过就诊日仍未接诊"的单记为未到诊（R3）。号源不回滚——那个号确实被占掉了，
     * 钱也不退，这是需求里写明的爽约口径，不是漏了退款。
     * 已接诊保持原状（医生可继续结束），未支付交给超时取消；候选 SQL 与这里的锁内判定是同一口径，
     * 两个定时任务的先后顺序因此不会改变终态。
     *
     * @return true 表示本次真的改了状态
     */
    @Transactional
    public boolean markMissedOne(Long id) {
        Appointment a = baseMapper.selectByIdForUpdate(id);
        if (a == null || a.getAppointmentDate() == null
                || !a.getAppointmentDate().isBefore(LocalDate.now())
                || a.getStatus() != Appointment.ST_PENDING
                || !Integer.valueOf(Appointment.PAY_PAID).equals(a.getPayStatus())) {
            return false;
        }
        return baseMapper.update(null, Wrappers.<Appointment>lambdaUpdate()
                .set(Appointment::getStatus, Appointment.ST_MISSED)
                .eq(Appointment::getId, id)
                .eq(Appointment::getStatus, Appointment.ST_PENDING)
                .eq(Appointment::getPayStatus, Appointment.PAY_PAID)) > 0;
    }

    // ---------------------------------------------------------------- 内部

    /** null 或全空白视为未传键；trim 后必须匹配 [A-Za-z0-9._:-]{8,64} */
    private static String normalizeIdemKey(String idemKey) {
        if (idemKey == null || idemKey.isBlank()) {
            return null;
        }
        String key = idemKey.trim();
        if (!IDEM_KEY.matcher(key).matches()) {
            throw new BizException("幂等键格式不正确");
        }
        return key;
    }

    /**
     * 幂等键命中后返回原单。参数不同（换宠物/换时段）不报错：键表达的是"这是同一次下单重试"，
     * 以首次落库的结果为准更安全——报错会让客户端拿着同一个键永远无法收敛。
     * 但要把分歧记进 WARN，便于排查客户端是否错误复用了键。
     */
    private AppointmentVo replayOf(Appointment existing, AppointmentForm req) {
        if (!Objects.equals(existing.getPetId(), req.getPetId())
                || !Objects.equals(existing.getScheduleId(), req.getScheduleId())) {
            log.warn("幂等键重放参数不一致，返回原单：appointment={} 首次 pet={} schedule={} 本次 pet={} schedule={}",
                    existing.getId(), existing.getPetId(), existing.getScheduleId(),
                    req.getPetId(), req.getScheduleId());
        }
        return detailOf(existing, false);
    }

    public static class VisitOverdueException extends BizException {
        public VisitOverdueException() { super("预约已过就诊日，已标记未到诊"); }
    }

    private void requireVisitNotOverdue(Appointment a) {
        if (a.getStatus() == Appointment.ST_PENDING && Integer.valueOf(Appointment.PAY_PAID).equals(a.getPayStatus())
                && a.getAppointmentDate() != null && a.getAppointmentDate().isBefore(LocalDate.now())) {
            markMissedOne(a.getId());
            throw new VisitOverdueException();
        }
    }

    /**
     * 临床动作（接诊、结束）的准入：必须是医生账号，而且只能动自己的单（R4）。
     *
     * 控制器上的 @RequireRole(DOCTOR) 是第一道，这条是第二道——RequireRole 的约定是 fail-open
     * （漏标即放行），所以不能只靠注解。管理员在这里仍被挡住，但可查、可代患者取消待接诊单。
     */
    private void requireDoctorMayTouch(Appointment a) {
        LoginUser u = UserContext.require();
        if (!u.isDoctor()) {
            throw BizException.forbidden("接诊与结束就诊仅限医生账号，管理员不能代为操作");
        }
        requireStaffMayTouch(a);
    }

    private void requireStaffMayTouch(Appointment a) {
        LoginUser u = UserContext.require();
        if (u.isDoctor() && !a.getDoctorId().equals(u.getDoctorId())) {
            throw BizException.forbidden("只能处理自己的接诊单");
        }
    }

    private void requireNotPast(DoctorSchedule sch) {
        LocalDate today = LocalDate.now();
        if (sch.getWorkDate().isBefore(today)) {
            throw new BizException("该时段已过期");
        }
        if (sch.getWorkDate().isEqual(today) && LocalTime.now().isAfter(sch.getEndTime())) {
            throw new BizException("该时段的门诊已经结束，请改约其他时间");
        }
    }

    /**
     * 到期判定只此一处：createTime + 超时分钟数 <= 当前时刻。
     * 支付和超时清扫比的是同一条线，刚越过这条线的支付即使抢到锁也照样失败，
     * 不会留下"号已被清扫退回、钱却记成已支付"的单。
     */
    private boolean isPayExpired(Appointment a) {
        if (a.getCreateTime() == null) {
            return false;
        }
        LocalDateTime deadline = a.getCreateTime().plusMinutes(props.getPayTimeoutMinutes());
        return !LocalDateTime.now().isBefore(deadline);
    }

    private String nextOrderNo() {
        return "PC" + LocalDateTime.now().format(NO_STAMP)
                + String.format(Locale.ROOT, "%08d", ThreadLocalRandom.current().nextInt(100_000_000));
    }

    private AppointmentVo detailOf(Appointment a, boolean withPatient) {
        return buildVos(List.of(a), withPatient).get(0);
    }

    private PageResult<AppointmentVo> voPage(Page<Appointment> page, boolean withPatient) {
        return PageResult.of(page, buildVos(page.getRecords(), withPatient));
    }

    /**
     * 批量补名字。一行订单要牵出宠物/医生/科室/下单人四张表，
     * 逐行查就是 N+1，所以先把 id 收齐、一次查回来做字典。
     */
    private List<AppointmentVo> buildVos(List<Appointment> rows, boolean withPatient) {
        if (rows.isEmpty()) {
            return List.of();
        }
        // 宠物展示信息走历史查询（含已删档案）：删档案不该让旧单据显示不出宠物
        Map<Long, PetDisplayVo> pets = BatchLookup.mapByIds(petMapper::selectHistoryDisplay,
                BatchLookup.ids(rows, Appointment::getPetId), PetDisplayVo::getId);

        Map<Long, Doctor> doctors = BatchLookup.mapByIds(doctorMapper::selectBatchIds,
                BatchLookup.ids(rows, Appointment::getDoctorId), Doctor::getId);

        Set<Long> deptIds = new HashSet<>(BatchLookup.ids(doctors.values(), Doctor::getDepartmentId));
        deptIds.addAll(BatchLookup.ids(rows, Appointment::getDepartmentId));
        Map<Long, Department> depts = BatchLookup.mapByIds(departmentMapper::selectBatchIds,
                deptIds, Department::getId);

        Map<Long, SysUser> users = withPatient
                ? BatchLookup.mapByIds(sysUserMapper::selectBatchIds,
                BatchLookup.ids(rows, Appointment::getUserId), SysUser::getId)
                : Map.of();

        Set<Long> orderIds = BatchLookup.ids(rows, Appointment::getId);
        Map<Long, Long> sessionIds = new HashMap<>();
        sessionMapper.selectList(Wrappers.<ConsultSession>lambdaQuery()
                        .in(ConsultSession::getAppointmentId, orderIds))
                .forEach(s -> sessionIds.putIfAbsent(s.getAppointmentId(), s.getId()));
        Map<Long, Long> recordIds = new HashMap<>();
        recordMapper.selectList(Wrappers.<MedicalRecord>lambdaQuery()
                        .in(MedicalRecord::getAppointmentId, orderIds))
                .forEach(r -> recordIds.putIfAbsent(r.getAppointmentId(), r.getId()));

        List<AppointmentVo> out = new ArrayList<>(rows.size());
        for (Appointment a : rows) {
            AppointmentVo vo = new AppointmentVo();
            BeanUtils.copyProperties(a, vo);
            if (a.getCreateTime() != null) {
                vo.setPayDeadline(a.getCreateTime().plusMinutes(props.getPayTimeoutMinutes()));
            }
            PetDisplayVo pet = pets.get(a.getPetId());
            if (pet != null) {
                vo.setPetName(pet.getName());
                vo.setPetSpecies(pet.getSpecies());
                vo.setPetBreed(pet.getBreed());
                vo.setPetAvatar(pet.getAvatar());
            }
            Doctor d = doctors.get(a.getDoctorId());
            if (d != null) {
                vo.setDoctorName(d.getName());
                vo.setDoctorTitle(d.getTitle());
                vo.setDoctorAvatar(d.getAvatar());
            }
            Department dept = depts.get(a.getDepartmentId());
            vo.setDepartmentName(dept == null ? null : dept.getName());
            if (withPatient) {
                SysUser u = users.get(a.getUserId());
                if (u != null) {
                    vo.setUserNickname(u.getNickname());
                    vo.setUserPhone(u.getPhone());
                }
            }
            vo.setSessionId(sessionIds.get(a.getId()));
            vo.setRecordId(recordIds.get(a.getId()));
            out.add(vo);
        }
        return out;
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }
}
