package com.yuzhua.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import com.yuzhua.common.BatchLookup;
import com.yuzhua.common.BizException;
import com.yuzhua.common.PageResult;
import com.yuzhua.dto.DoctorForm;
import com.yuzhua.dto.DoctorQuery;
import com.yuzhua.entity.*;
import com.yuzhua.mapper.*;
import com.yuzhua.websocket.ConsultSocketRegistry;
import com.yuzhua.vo.DoctorVo;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * 医生（院内员工花名册）。单家医院自用，所以没有入驻审核，只有"停诊/正常"开关。
 */
@Service
@RequiredArgsConstructor
public class DoctorService extends ServiceImpl<DoctorMapper, Doctor> {

    private final DepartmentMapper departmentMapper;
    private final DoctorScheduleMapper scheduleMapper;
    private final AppointmentMapper appointmentMapper;
    private final MedicalRecordMapper recordMapper;
    private final ConsultSessionMapper sessionMapper;
    private final DoctorReviewMapper reviewMapper;
    private final AdminUserMapper adminUserMapper;
    private final ConsultSocketRegistry socketRegistry;

    /**
     * 医生分页。用户端与后台共用一套筛选条件，差别只在 visibleOnly：
     * 用户端传 true 时强制只出正常出诊的医生，后台停诊的也要能列出来。
     */
    public PageResult<DoctorVo> pageVo(DoctorQuery q, boolean visibleOnly) {
        LambdaQueryWrapper<Doctor> qw = Wrappers.<Doctor>lambdaQuery()
                .eq(q.getDepartmentId() != null, Doctor::getDepartmentId, q.getDepartmentId())
                .eq(q.getStatus() != null, Doctor::getStatus, q.getStatus())
                .and(q.getKeyword() != null && !q.getKeyword().isBlank(), w -> w
                        .like(Doctor::getName, q.getKeyword())
                        .or().like(Doctor::getSpecialty, q.getKeyword())
                        .or().like(Doctor::getTitle, q.getKeyword()));
        if (visibleOnly) {
            qw.eq(Doctor::getStatus, 1);
        }
        applySort(qw, q.getSort());

        Page<Doctor> page = page(new Page<>(q.getPageNum(), q.getPageSize()), qw);
        Map<Long, Department> dict = departmentNames(page.getRecords());
        List<DoctorVo> rows = page.getRecords().stream()
                .map(d -> toVo(d, dict))
                .toList();
        return PageResult.of(page, rows);
    }

    public DoctorVo detail(Long id) {
        Doctor d = require(id);
        return toVo(d, departmentNames(List.of(d)));
    }

    /** 用户端医生卡片的精简版：只保留公开字段，供首页/搜索结果用 */
    public List<DoctorVo> listTopVisible(int limit) {
        List<Doctor> list = list(Wrappers.<Doctor>lambdaQuery()
                .eq(Doctor::getStatus, 1)
                .orderByAsc(Doctor::getSort)
                .orderByDesc(Doctor::getRating)
                .last("LIMIT " + Math.max(1, Math.min(limit, 50))));
        Map<Long, Department> dict = departmentNames(list);
        return list.stream().map(d -> toVo(d, dict)).toList();
    }

    public Doctor require(Long id) {
        Doctor d = getById(id);
        if (d == null) {
            throw BizException.notFound("医生");
        }
        return d;
    }

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public Doctor create(DoctorForm form) {
        requireName(form.getName());
        requireDepartment(form.getDepartmentId());
        requireFee(form.getConsultationFee());
        if (form.getStatus() != null) {
            requireStatus(form.getStatus());
        }
        Doctor d = new Doctor();
        d.setName(form.getName());
        d.setAvatar(form.getAvatar());
        d.setGender(form.getGender());
        d.setPhone(form.getPhone());
        d.setTitle(form.getTitle());
        d.setDepartmentId(form.getDepartmentId());
        d.setSpecialty(form.getSpecialty());
        d.setIntroduction(form.getIntroduction());
        d.setWorkYears(form.getWorkYears());
        d.setConsultationFee(form.getConsultationFee());
        d.setRating(new BigDecimal("5.0"));
        d.setReviewCount(0);
        d.setAppointmentCount(0);
        d.setOnlineStatus(0);
        d.setStatus(form.getStatus() == null ? 1 : form.getStatus());
        d.setSort(form.getSort() == null ? 99 : form.getSort());
        save(d);
        return d;
    }

    /**
     * 评分、接诊量、在线状态由评价、完成预约和 WebSocket 维护，请求体里也没有这些字段；
     * 状态不在通用更新里写，停诊/恢复还要同步在线标志，统一走 applyStatus。
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void update(Long id, DoctorForm form) {
        require(id);
        requireName(form.getName());
        requireDepartment(form.getDepartmentId());
        requireFee(form.getConsultationFee());
        Integer status = form.getStatus();
        if (status != null) {
            requireStatus(status);
        }
        Doctor row = new Doctor();
        row.setId(id);
        row.setName(form.getName());
        row.setAvatar(form.getAvatar());
        row.setGender(form.getGender());
        row.setPhone(form.getPhone());
        row.setTitle(form.getTitle());
        row.setDepartmentId(form.getDepartmentId());
        row.setSpecialty(form.getSpecialty());
        row.setIntroduction(form.getIntroduction());
        row.setWorkYears(form.getWorkYears());
        row.setConsultationFee(form.getConsultationFee());
        row.setSort(form.getSort());
        updateById(row);
        if (status != null) {
            applyStatus(id, status);
        }
    }

    /**
     * 停诊 / 恢复出诊。停诊只挡住将来的号，
     * 已经约出去的单子和排班行保持原样，由前台电话联系改约。
     */
    @Transactional
    public void changeStatus(Long id, Integer status) {
        require(id);
        applyStatus(id, status);
    }

    /**
     * 状态写入的唯一出口：编辑弹窗与停诊/恢复按钮共用。
     * 恢复出诊时只有仍挂着活动连接才记为在线，避免医生早已断线却显示在线。
     */
    private void applyStatus(Long id, Integer status) {
        requireStatus(status);
        update(Wrappers.<Doctor>lambdaUpdate()
                .set(Doctor::getStatus, status)
                .set(Doctor::getOnlineStatus, status == 1 && socketRegistry.doctorConnected(id) ? 1 : 0)
                .eq(Doctor::getId, id));
    }

    private static void requireStatus(Integer status) {
        if (status == null || (status != 0 && status != 1)) {
            throw new BizException("状态只能是停诊或出诊");
        }
    }

    @Transactional
    public void remove(Long id) {
        require(id);
        if (scheduleMapper.selectCount(Wrappers.<DoctorSchedule>lambdaQuery().eq(DoctorSchedule::getDoctorId, id)) > 0
                || appointmentMapper.selectCount(Wrappers.<Appointment>lambdaQuery().eq(Appointment::getDoctorId, id)) > 0
                || recordMapper.selectCount(Wrappers.<MedicalRecord>lambdaQuery().eq(MedicalRecord::getDoctorId, id)) > 0
                || sessionMapper.selectCount(Wrappers.<ConsultSession>lambdaQuery().eq(ConsultSession::getDoctorId, id)) > 0
                || reviewMapper.selectCount(Wrappers.<DoctorReview>lambdaQuery().eq(DoctorReview::getDoctorId, id)) > 0
                || adminUserMapper.selectCount(Wrappers.<AdminUser>lambdaQuery().eq(AdminUser::getDoctorId, id)) > 0) {
            throw new BizException("医生有关联排班、业务记录或后台账号，请使用停诊保留档案");
        }
        removeById(id);
    }

    @Transactional
    public void refreshStats(Long doctorId) {
        baseMapper.refreshStats(doctorId);
        baseMapper.refreshAppointmentCount(doctorId);
    }

    private void applySort(LambdaQueryWrapper<Doctor> qw, String sort) {
        switch (sort == null ? "" : sort) {
            case "rating" -> qw.orderByDesc(Doctor::getRating).orderByDesc(Doctor::getReviewCount);
            case "appointment" -> qw.orderByDesc(Doctor::getAppointmentCount);
            default -> qw.orderByAsc(Doctor::getSort).orderByAsc(Doctor::getId);
        }
    }

    private void requireName(String name) {
        if (name == null || name.isBlank()) {
            throw new BizException("请填写医生姓名");
        }
    }

    static void requireFee(BigDecimal fee) {
        if (fee == null || fee.signum() < 0 || fee.compareTo(new BigDecimal("9999")) > 0
                || fee.stripTrailingZeros().scale() > 2) {
            throw new BizException("问诊费须为 0～9999 元，最多两位小数");
        }
    }

    /**
     * 确认目标科室存在，并持有它的行锁直到事务结束。
     *
     * <p>必须用锁定读而不是 {@code selectById}：删除科室的路径会先拿同一把锁再统计医生，
     * 两边串行化之后，"新增/转科"与"删除"的检查才不会同时通过。
     * 只有一个目标科室参与加锁；若将来需要同时锁多个科室，按 ID 升序加锁以避免死锁。
     * 调用方必须处在事务中，否则语句一结束锁就释放，起不到互斥作用。
     */
    private void requireDepartment(Long departmentId) {
        if (departmentId == null) {
            throw new BizException("请选择所属科室");
        }
        if (departmentMapper.selectByIdForUpdate(departmentId) == null) {
            throw BizException.notFound("科室");
        }
    }

    /** 一次把本页涉及的科室查出来做字典，避免每行一次查询 */
    private Map<Long, Department> departmentNames(List<Doctor> doctors) {
        return BatchLookup.mapByIds(departmentMapper::selectBatchIds,
                BatchLookup.ids(doctors, Doctor::getDepartmentId), Department::getId);
    }

    private DoctorVo toVo(Doctor d, Map<Long, Department> dict) {
        DoctorVo vo = new DoctorVo();
        BeanUtils.copyProperties(d, vo);
        Department dept = dict.get(d.getDepartmentId());
        if (dept != null) {
            vo.setDepartmentName(dept.getName());
            vo.setDepartmentIcon(dept.getIcon());
        }
        return vo;
    }
}
