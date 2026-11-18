package com.yuzhua.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import com.yuzhua.common.BizException;
import com.yuzhua.common.BatchLookup;
import com.yuzhua.common.PageResult;
import com.yuzhua.dto.MedicalRecordForm;
import com.yuzhua.dto.PageQuery;
import com.yuzhua.dto.RecordQuery;
import com.yuzhua.entity.Appointment;
import com.yuzhua.entity.Department;
import com.yuzhua.entity.Doctor;
import com.yuzhua.entity.MedicalRecord;
import com.yuzhua.mapper.DepartmentMapper;
import com.yuzhua.mapper.DoctorMapper;
import com.yuzhua.mapper.MedicalRecordMapper;
import com.yuzhua.mapper.PetMapper;
import com.yuzhua.security.LoginUser;
import com.yuzhua.security.UserContext;
import com.yuzhua.vo.MedicalRecordVo;
import com.yuzhua.vo.PetDisplayVo;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 病历/处方。一张预约对应一份病历，由接诊医生在问诊过程中或结束时填写。
 *
 * 写完仍可修订（复诊补充），但只能由签约医生本人改，
 * 而且状态白名单之外的单一律不能写病历——待接诊、已取消、未到诊都不行（R7），
 * 不然能给没来看过的宠物开处方。
 */
@Service
@RequiredArgsConstructor
public class MedicalRecordService extends ServiceImpl<MedicalRecordMapper, MedicalRecord> {

    // 同预约单号：并发首次保存会撞 uk_record_no，秒级精度不够
    private static final DateTimeFormatter NO_STAMP = DateTimeFormatter.ofPattern("yyyyMMddHHmmssSSS");

    private final AppointmentService appointmentService;
    private final DoctorMapper doctorMapper;
    private final PetMapper petMapper;
    private final DepartmentMapper departmentMapper;

    /** 医生开病历：没有就新增，有就修订 */
    @Transactional
    public MedicalRecord saveOrUpdateForAppointment(Long appointmentId, MedicalRecordForm req) {
        // 先锁预约行再判状态与归属：下面的"查有没有—没有就插"必须在这把锁之内，
        // 否则两个并发首次保存会各自查空、各插一份（跟踪表 I09/M2）
        Appointment a = requireStaffAppointmentLocked(appointmentId);
        // R7：状态判定用白名单而不是黑名单。待接诊（还没看）、已取消（没来看）、
        // 未到诊（爽约）都不该有病历；黑名单写法漏一个状态就多开一个口子（跟踪表 I05/M1）。
        // 结束就诊前不强制已有病历，所以已完成仍可事后补写。
        if (a.getStatus() != Appointment.ST_ACCEPTED && a.getStatus() != Appointment.ST_FINISHED) {
            throw new BizException("仅已接诊或已完成的预约可填写病历");
        }
        if (req.getDiagnosis() == null || req.getDiagnosis().isBlank()) {
            throw new BizException("请填写诊断结论");
        }

        MedicalRecord exist = getOne(Wrappers.<MedicalRecord>lambdaQuery()
                .eq(MedicalRecord::getAppointmentId, appointmentId), false);
        MedicalRecord r = new MedicalRecord();
        r.setAppointmentId(appointmentId);
        r.setChiefComplaint(req.getChiefComplaint());
        r.setPhysicalExam(req.getPhysicalExam());
        r.setDiagnosis(req.getDiagnosis().trim());
        r.setPrescription(req.getPrescription());
        r.setTreatment(req.getTreatment());
        r.setAdvice(req.getAdvice());
        r.setNextVisitDate(req.getNextVisitDate());
        r.setImages(req.getImages());
        r.setVisitDate(a.getAppointmentDate() == null ? LocalDate.now() : a.getAppointmentDate());
        if (exist == null) {
            r.setRecordNo("MR" + LocalDateTime.now().format(NO_STAMP)
                    + String.format(Locale.ROOT, "%04d", ThreadLocalRandom.current().nextInt(10000)));
            r.setUserId(a.getUserId());
            r.setPetId(a.getPetId());
            r.setDoctorId(a.getDoctorId());
            r.setDepartmentId(a.getDepartmentId());
            save(r);
        } else {
            r.setId(exist.getId());
            update(r, Wrappers.<MedicalRecord>lambdaUpdate().eq(MedicalRecord::getId, exist.getId())
                    .set(req.isNextVisitDateSubmitted(), MedicalRecord::getNextVisitDate, req.getNextVisitDate()));
        }
        return getById(r.getId());
    }

    public MedicalRecord require(Long id) {
        MedicalRecord r = getById(id);
        if (r == null) {
            throw BizException.notFound("病历");
        }
        return r;
    }

    /** 用户端我的病历：只出与自己宠物相关的 */
    public PageResult<MedicalRecordVo> pageMine(PageQuery q) {
        LambdaQueryWrapper<MedicalRecord> qw = Wrappers.<MedicalRecord>lambdaQuery()
                .eq(MedicalRecord::getUserId, UserContext.requireId())
                .orderByDesc(MedicalRecord::getVisitDate)
                .orderByDesc(MedicalRecord::getId);
        IPage<MedicalRecord> page = page(new Page<>(q.getPageNum(), q.getPageSize()), qw);
        return PageResult.of(page, fillNames(page.getRecords()));
    }

    /** 后台 / 医生工作台的病历列表：医生账号只能翻到自己写的 */
    public PageResult<MedicalRecordVo> pageForStaff(RecordQuery q) {
        LoginUser u = UserContext.require();
        Long doctorId = u.isDoctor() ? UserContext.requireDoctorId() : q.getDoctorId();
        String keyword = q.getKeyword();
        LambdaQueryWrapper<MedicalRecord> qw = Wrappers.<MedicalRecord>lambdaQuery()
                .eq(doctorId != null, MedicalRecord::getDoctorId, doctorId)
                .eq(q.getPetId() != null, MedicalRecord::getPetId, q.getPetId())
                .and(keyword != null && !keyword.isBlank(), w -> w
                        .like(MedicalRecord::getDiagnosis, keyword)
                        .or().like(MedicalRecord::getChiefComplaint, keyword)
                        .or().like(MedicalRecord::getRecordNo, keyword))
                .orderByDesc(MedicalRecord::getId);
        IPage<MedicalRecord> page = page(new Page<>(q.getPageNum(), q.getPageSize()), qw);
        return PageResult.of(page, fillNames(page.getRecords()));
    }

    /**
     * 列表批量补名字。逐行 selectById 会打出 N+1，这里每类 id 去重后各查一次。
     */
    private List<MedicalRecordVo> fillNames(List<MedicalRecord> rows) {
        // 宠物展示信息走历史查询（含已删档案）：删档案不该让旧病历显示不出宠物
        Map<Long, PetDisplayVo> pets = BatchLookup.mapByIds(petMapper::selectHistoryDisplay,
                BatchLookup.ids(rows, MedicalRecord::getPetId), PetDisplayVo::getId);
        Map<Long, Doctor> doctors = BatchLookup.mapByIds(doctorMapper::selectBatchIds,
                BatchLookup.ids(rows, MedicalRecord::getDoctorId), Doctor::getId);
        Map<Long, Department> depts = BatchLookup.mapByIds(departmentMapper::selectBatchIds,
                BatchLookup.ids(rows, MedicalRecord::getDepartmentId), Department::getId);
        return rows.stream().map(r -> {
            MedicalRecordVo vo = new MedicalRecordVo();
            BeanUtils.copyProperties(r, vo);
            PetDisplayVo pet = pets.get(r.getPetId());
            if (pet != null) {
                vo.setPetName(pet.getName());
                vo.setPetSpecies(pet.getSpecies());
                vo.setPetBreed(pet.getBreed());
                vo.setPetAvatar(pet.getAvatar());
            }
            Doctor d = doctors.get(r.getDoctorId());
            if (d != null) {
                vo.setDoctorName(d.getName());
                vo.setDoctorTitle(d.getTitle());
            }
            Department dept = depts.get(r.getDepartmentId());
            vo.setDepartmentName(dept == null ? null : dept.getName());
            return vo;
        }).toList();
    }

    /** 详情：把宠物、医生、科室名字拼上，打印病历单时不再二次查询 */
    public MedicalRecordVo detail(Long id) {
        MedicalRecord r = require(id);
        LoginUser u = UserContext.require();
        if (u.isClient() && !r.getUserId().equals(u.getId())) {
            throw BizException.notFound("病历");
        }
        if (u.isDoctor() && !r.getDoctorId().equals(u.getDoctorId())) {
            throw BizException.forbidden("看不到别人的病历");
        }
        MedicalRecordVo vo = new MedicalRecordVo();
        BeanUtils.copyProperties(r, vo);
        // 与列表同走历史查询入口（含已删档案），详情不再单独按普通查询取宠物
        PetDisplayVo pet = BatchLookup.mapByIds(petMapper::selectHistoryDisplay,
                BatchLookup.ids(List.of(r), MedicalRecord::getPetId), PetDisplayVo::getId).get(r.getPetId());
        if (pet != null) {
            vo.setPetName(pet.getName());
            vo.setPetSpecies(pet.getSpecies());
            vo.setPetBreed(pet.getBreed());
            vo.setPetAvatar(pet.getAvatar());
        }
        Doctor d = doctorMapper.selectById(r.getDoctorId());
        if (d != null) {
            vo.setDoctorName(d.getName());
            vo.setDoctorTitle(d.getTitle());
        }
        Department dept = r.getDepartmentId() == null ? null : departmentMapper.selectById(r.getDepartmentId());
        vo.setDepartmentName(dept == null ? null : dept.getName());
        return vo;
    }

    /** 某张预约单上的病历，前端判断"要不要显示写病历按钮"；没有则返回 null */
    public MedicalRecord ofAppointment(Long appointmentId) {
        return getOne(Wrappers.<MedicalRecord>lambdaQuery()
                .eq(MedicalRecord::getAppointmentId, appointmentId), false);
    }

    /** 后台按预约单取病历 */
    public MedicalRecord ofAppointmentForStaff(Long appointmentId) {
        requireStaffAppointment(appointmentId);
        return ofAppointment(appointmentId);
    }

    /** 用户端按自己的预约单取病历 */
    public MedicalRecord ofAppointmentForOwner(Long appointmentId) {
        appointmentService.requireMine(appointmentId);
        return ofAppointment(appointmentId);
    }

    /** 预约单存在、且当前后台账号有权在其上读写病历 */
    private Appointment requireStaffAppointment(Long appointmentId) {
        Appointment a = appointmentService.requireExists(appointmentId);
        requireMayTouch(a);
        return a;
    }

    /**
     * 同上，但先锁住预约行：写入路径（新增/修订病历）必须用它，
     * 并且比读路径多收敛一层——读病历管理员可以，写病历只放医生账号（R4）。
     */
    private Appointment requireStaffAppointmentLocked(Long appointmentId) {
        Appointment a = appointmentService.lockForWrite(appointmentId);
        LoginUser u = UserContext.require();
        if (!u.isDoctor()) {
            throw BizException.forbidden("病历只能由医生账号书写，管理员为只读");
        }
        requireMayTouch(a);
        return a;
    }

    private void requireMayTouch(Appointment a) {
        LoginUser u = UserContext.require();
        if (u.isDoctor() && !a.getDoctorId().equals(u.getDoctorId())) {
            throw BizException.forbidden("只能处理自己接诊的单子");
        }
    }

}
