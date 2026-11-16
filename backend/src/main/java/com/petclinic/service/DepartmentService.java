package com.petclinic.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import com.petclinic.common.BizException;
import com.petclinic.common.PageResult;
import com.petclinic.dto.DepartmentForm;
import com.petclinic.dto.PageQuery;
import com.petclinic.entity.Department;
import com.petclinic.entity.Doctor;
import com.petclinic.mapper.DepartmentMapper;
import com.petclinic.mapper.DoctorMapper;
import com.petclinic.mapper.AppointmentMapper;
import com.petclinic.mapper.MedicalRecordMapper;
import com.petclinic.mapper.DoctorReviewMapper;
import com.petclinic.entity.Appointment;
import com.petclinic.entity.MedicalRecord;
import com.petclinic.entity.DoctorReview;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 科室。
 */
@Service
@RequiredArgsConstructor
public class DepartmentService extends ServiceImpl<DepartmentMapper, Department> {

    private final DoctorMapper doctorMapper;
    private final AppointmentMapper appointmentMapper;
    private final MedicalRecordMapper recordMapper;
    private final DoctorReviewMapper reviewMapper;

    /** 用户端科室导航：只给启用的，按后台配的 sort 排 */
    public List<Department> listEnabled() {
        return list(Wrappers.<Department>lambdaQuery()
                .eq(Department::getStatus, 1)
                .orderByAsc(Department::getSort)
                .orderByAsc(Department::getId));
    }

    public PageResult<Department> page(PageQuery query, String keyword) {
        LambdaQueryWrapper<Department> qw = Wrappers.<Department>lambdaQuery()
                .like(keyword != null && !keyword.isBlank(), Department::getName, keyword)
                .orderByAsc(Department::getSort)
                .orderByAsc(Department::getId);
        return PageResult.of(page(new Page<>(query.getPageNum(), query.getPageSize()), qw));
    }

    @Transactional
    public Department create(DepartmentForm form) {
        requireName(form.getName());
        requireCode(form.getCode());
        if (form.getStatus() != null) {
            requireStatus(form.getStatus());
        }
        if (exists(Wrappers.<Department>lambdaQuery().eq(Department::getCode, form.getCode()))) {
            throw new BizException("科室编码 " + form.getCode() + " 已存在");
        }
        Department d = new Department();
        d.setName(form.getName());
        d.setCode(form.getCode());
        d.setIcon(form.getIcon());
        d.setDescription(form.getDescription());
        d.setSort(form.getSort() == null ? 99 : form.getSort());
        d.setStatus(form.getStatus() == null ? 1 : form.getStatus());
        save(d);
        return d;
    }

    @Transactional
    public void update(Long id, DepartmentForm form) {
        Department d = require(id);
        requireName(form.getName());
        requireCode(form.getCode());
        if (form.getStatus() != null) {
            requireStatus(form.getStatus());
        }
        if (!form.getCode().equals(d.getCode())
                && exists(Wrappers.<Department>lambdaQuery()
                .eq(Department::getCode, form.getCode()).ne(Department::getId, id))) {
            throw new BizException("科室编码 " + form.getCode() + " 已存在");
        }
        Department row = new Department();
        row.setId(id);
        row.setName(form.getName());
        row.setCode(form.getCode());
        row.setIcon(form.getIcon());
        row.setDescription(form.getDescription());
        row.setSort(form.getSort());
        row.setStatus(form.getStatus());
        updateById(row);
    }

    /**
     * 删除前必须确认没有医生挂靠：appointment 里有 department_id 冗余列，
     * 真删掉科室会让历史预约记录显示成"未知科室"。
     *
     * <p>与 {@code DoctorService} 的写入共用同一把科室行锁：先锁定读目标行，再在锁内
     * 统计引用。否则"删除方数完 0 名医生"与"新增方确认科室存在"可能同时通过，
     * 留下指向已删科室的医生。事务用 READ_COMMITTED：等到锁之后执行的普通查询
     * 必须看到等待期间已提交的引用，不能沿用旧快照。
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void remove(Long id) {
        // 锁定读。这里的判空同时承担"科室存在"校验，不能用快照读替代
        if (baseMapper.selectByIdForUpdate(id) == null) {
            throw BizException.notFound("科室");
        }
        long mounted = doctorMapper.selectCount(Wrappers.<Doctor>lambdaQuery()
                .eq(Doctor::getDepartmentId, id));
        if (mounted > 0) {
            throw new BizException("该科室下还有 " + mounted + " 名医生，请先调整医生归属");
        }
        if (appointmentMapper.selectCount(Wrappers.<Appointment>lambdaQuery().eq(Appointment::getDepartmentId, id)) > 0
                || recordMapper.selectCount(Wrappers.<MedicalRecord>lambdaQuery().eq(MedicalRecord::getDepartmentId, id)) > 0
                || reviewMapper.selectCount(Wrappers.<DoctorReview>lambdaQuery().eq(DoctorReview::getDepartmentId, id)) > 0) {
            throw new BizException("科室已有业务记录，请使用停用保留档案");
        }
        removeById(id);
    }

    public void changeStatus(Long id, Integer status) {
        requireStatus(status);
        require(id);
        update(Wrappers.<Department>lambdaUpdate()
                .set(Department::getStatus, status)
                .eq(Department::getId, id));
    }

    public Department require(Long id) {
        Department d = getById(id);
        if (d == null) {
            throw BizException.notFound("科室");
        }
        return d;
    }

    private void requireName(String name) {
        if (name == null || name.isBlank()) {
            throw new BizException("请填写科室名称");
        }
    }

    /** 编码是唯一键的一部分，空值既会撞库也会让后续补录分不清科室 */
    private void requireCode(String code) {
        if (code == null || code.isBlank()) {
            throw new BizException("请填写科室编码");
        }
    }

    /** 状态只允许 0 停用 / 1 启用；缺省状态由各写入入口决定是否放行 */
    private void requireStatus(Integer status) {
        if (status == null || (status != 0 && status != 1)) {
            throw new BizException("状态只能是停用或启用");
        }
    }
}
