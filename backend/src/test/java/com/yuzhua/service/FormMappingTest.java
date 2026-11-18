package com.yuzhua.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.AbstractWrapper;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.yuzhua.dto.DepartmentForm;
import com.yuzhua.dto.DoctorForm;
import com.yuzhua.dto.MedicalRecordForm;
import com.yuzhua.dto.NoticeForm;
import com.yuzhua.dto.PetForm;
import com.yuzhua.entity.Appointment;
import com.yuzhua.entity.Department;
import com.yuzhua.entity.Doctor;
import com.yuzhua.entity.MedicalRecord;
import com.yuzhua.entity.Notice;
import com.yuzhua.entity.Pet;
import com.yuzhua.mapper.AdminUserMapper;
import com.yuzhua.mapper.AppointmentMapper;
import com.yuzhua.mapper.ConsultSessionMapper;
import com.yuzhua.mapper.DepartmentMapper;
import com.yuzhua.mapper.DoctorMapper;
import com.yuzhua.mapper.DoctorReviewMapper;
import com.yuzhua.mapper.DoctorScheduleMapper;
import com.yuzhua.mapper.MedicalRecordMapper;
import com.yuzhua.mapper.PetMapper;
import com.yuzhua.mapper.SysUserMapper;
import com.yuzhua.security.LoginUser;
import com.yuzhua.security.UserContext;
import com.yuzhua.websocket.ConsultSocketRegistry;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.lang.reflect.Proxy;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 请求 Form → 持久化实体的全字段映射。
 *
 * <p>Form 化的主要风险不是系统字段（结构上已经进不来），而是漏掉某个可编辑字段：
 * 它不会编译失败，只会在保存时静默丢弃。每个聚合都要把表单里所有可编辑字段填满，
 * 再断言 mapper 收到的实体逐项一致。
 */
class FormMappingTest {

    @BeforeAll
    static void initTableInfo() {
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), "test"), Department.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), "test"), Doctor.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), "test"), Pet.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), "test"), MedicalRecord.class);
    }

    @AfterEach
    void clearContext() {
        UserContext.clear();
    }

    static void asAdmin() {
        LoginUser admin = new LoginUser();
        admin.setId(1L);
        admin.setTyp(LoginUser.TYP_ADMIN);
        admin.setRole(LoginUser.ROLE_ADMIN);
        UserContext.set(admin);
    }

    static void asClient() {
        LoginUser client = new LoginUser();
        client.setId(1L);
        client.setTyp(LoginUser.TYP_CLIENT);
        client.setRole(LoginUser.ROLE_USER);
        UserContext.set(client);
    }

    static void asDoctor(long doctorId) {
        LoginUser doctor = new LoginUser();
        doctor.setId(99L);
        doctor.setTyp(LoginUser.TYP_ADMIN);
        doctor.setRole(LoginUser.ROLE_DOCTOR);
        doctor.setDoctorId(doctorId);
        UserContext.set(doctor);
    }

    @SuppressWarnings("unchecked")
    static <T> T mapper(Class<T> type, Function<String, Object> result) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type},
                (proxy, method, args) -> result.apply(method.getName()));
    }

    static class DeptService extends DepartmentService {
        Department current;
        Department saved;

        DeptService() {
            super(mapper(DoctorMapper.class, name -> null),
                    mapper(AppointmentMapper.class, name -> 0L),
                    mapper(MedicalRecordMapper.class, name -> 0L),
                    mapper(DoctorReviewMapper.class, name -> 0L));
        }

        @Override
        public boolean exists(Wrapper<Department> query) {
            return false;
        }

        @Override
        public boolean save(Department row) {
            saved = row;
            return true;
        }

        @Override
        public boolean updateById(Department row) {
            saved = row;
            return true;
        }

        @Override
        public Department require(Long id) {
            return current;
        }
    }

    static DepartmentForm departmentForm(String name, String code, String icon, String description,
                                         Integer sort, Integer status) {
        DepartmentForm f = new DepartmentForm();
        f.setName(name);
        f.setCode(code);
        f.setIcon(icon);
        f.setDescription(description);
        f.setSort(sort);
        f.setStatus(status);
        return f;
    }

    @Test
    void departmentFormMapsEveryEditableFieldOnCreate() {
        DeptService s = new DeptService();
        Department created = s.create(departmentForm("影像科", "YX", "xray", "影像检查", 7, 0));

        assertEquals("影像科", s.saved.getName());
        assertEquals("YX", s.saved.getCode());
        assertEquals("xray", s.saved.getIcon());
        assertEquals("影像检查", s.saved.getDescription());
        assertEquals(7, s.saved.getSort());
        assertEquals(0, s.saved.getStatus());
        assertNull(s.saved.getId(), "id 由数据库生成，不应来自表单");
        assertNull(s.saved.getCreateTime(), "系统时间由 MyBatis-Plus 填充，不应来自请求");
        assertNull(s.saved.getUpdateTime());
        assertEquals("影像科", created.getName(), "create 返回的实体应与落库对象一致");
    }

    @Test
    void departmentFormMapsEveryEditableFieldOnUpdate() {
        DeptService s = new DeptService();
        s.current = new Department();
        s.current.setId(9L);
        s.current.setCode("YX");

        s.update(9L, departmentForm("影像科（新）", "YX2", "ct", "更新后的简介", 3, 1));

        assertEquals(9L, s.saved.getId(), "路径 id 优先于请求体");
        assertEquals("影像科（新）", s.saved.getName());
        assertEquals("YX2", s.saved.getCode());
        assertEquals("ct", s.saved.getIcon());
        assertEquals("更新后的简介", s.saved.getDescription());
        assertEquals(3, s.saved.getSort());
        assertEquals(1, s.saved.getStatus());
        assertNull(s.saved.getCreateTime());
        assertNull(s.saved.getUpdateTime());
    }

    // ---------------------------------------------------------------- 医生

    static <T> List<Object> values(Wrapper<T> wrapper) {
        return new ArrayList<>(((AbstractWrapper<?, ?, ?>) wrapper).getParamNameValuePairs().values());
    }

    static class DocService extends DoctorService {
        Doctor current;
        Doctor saved;
        Wrapper<Doctor> updated;

        DocService() {
            super(
                    mapper(DepartmentMapper.class, name -> {
                        Department d = new Department();
                        d.setId(1L);
                        return d;
                    }),
                    mapper(DoctorScheduleMapper.class, name -> null),
                    mapper(AppointmentMapper.class, name -> 0L),
                    mapper(MedicalRecordMapper.class, name -> 0L),
                    mapper(ConsultSessionMapper.class, name -> 0L),
                    mapper(DoctorReviewMapper.class, name -> 0L),
                    mapper(AdminUserMapper.class, name -> 0L),
                    new ConsultSocketRegistry());
        }

        @Override
        public Doctor require(Long id) {
            return current;
        }

        @Override
        public boolean save(Doctor row) {
            saved = row;
            return true;
        }

        @Override
        public boolean updateById(Doctor row) {
            saved = row;
            return true;
        }

        @Override
        public boolean update(Wrapper<Doctor> query) {
            updated = query;
            return true;
        }
    }

    static DoctorForm doctorForm(Integer status) {
        DoctorForm f = new DoctorForm();
        f.setName("陈明远");
        f.setAvatar("/api/uploads/doctor.png");
        f.setGender(2);
        f.setPhone("13800138000");
        f.setTitle("副主任医师");
        f.setDepartmentId(1L);
        f.setSpecialty("猫科,皮肤病");
        f.setIntroduction("从业十年，擅长猫科与皮肤病。");
        f.setWorkYears(10);
        f.setConsultationFee(new BigDecimal("88.50"));
        f.setStatus(status);
        f.setSort(4);
        return f;
    }

    @Test
    void doctorFormMapsEveryEditableFieldOnCreate() {
        DocService s = new DocService();
        Doctor created = s.create(doctorForm(0));

        assertEquals("陈明远", s.saved.getName());
        assertEquals("/api/uploads/doctor.png", s.saved.getAvatar());
        assertEquals(2, s.saved.getGender());
        assertEquals("13800138000", s.saved.getPhone());
        assertEquals("副主任医师", s.saved.getTitle());
        assertEquals(1L, s.saved.getDepartmentId());
        assertEquals("猫科,皮肤病", s.saved.getSpecialty());
        assertEquals("从业十年，擅长猫科与皮肤病。", s.saved.getIntroduction());
        assertEquals(10, s.saved.getWorkYears());
        assertEquals(new BigDecimal("88.50"), s.saved.getConsultationFee());
        assertEquals(0, s.saved.getStatus());
        assertEquals(4, s.saved.getSort());
        // 聚合字段与系统字段由服务端初始化，不来自表单
        assertEquals(new BigDecimal("5.0"), s.saved.getRating());
        assertEquals(0, s.saved.getReviewCount());
        assertEquals(0, s.saved.getAppointmentCount());
        assertEquals(0, s.saved.getOnlineStatus());
        assertNull(s.saved.getId());
        assertNull(s.saved.getCreateTime());
        assertEquals("陈明远", created.getName());
    }

    @Test
    void doctorFormMapsEveryEditableFieldOnUpdate() {
        DocService s = new DocService();
        s.current = new Doctor();
        s.current.setId(9L);

        s.update(9L, doctorForm(0));

        assertEquals(9L, s.saved.getId(), "路径 id 优先于请求体");
        assertEquals("陈明远", s.saved.getName());
        assertEquals("/api/uploads/doctor.png", s.saved.getAvatar());
        assertEquals(2, s.saved.getGender());
        assertEquals("13800138000", s.saved.getPhone());
        assertEquals("副主任医师", s.saved.getTitle());
        assertEquals(1L, s.saved.getDepartmentId());
        assertEquals("猫科,皮肤病", s.saved.getSpecialty());
        assertEquals("从业十年，擅长猫科与皮肤病。", s.saved.getIntroduction());
        assertEquals(10, s.saved.getWorkYears());
        assertEquals(new BigDecimal("88.50"), s.saved.getConsultationFee());
        assertEquals(4, s.saved.getSort());
        // 状态与在线标志由 applyStatus 一次写清，不混进通用字段更新
        assertNull(s.saved.getStatus());
        assertTrue(values(s.updated).contains(0));
        assertNull(s.saved.getCreateTime());
        assertNull(s.saved.getUpdateTime());
    }

    // ---------------------------------------------------------------- 公告

    static class NoticeSvc extends NoticeService {
        Notice current;
        Notice saved;

        @Override
        public boolean save(Notice row) {
            saved = row;
            return true;
        }

        @Override
        public boolean updateById(Notice row) {
            saved = row;
            return true;
        }

        @Override
        public Notice require(Long id) {
            return current;
        }
    }

    static NoticeForm noticeForm(String title, int type, int topFlag, int status) {
        NoticeForm f = new NoticeForm();
        f.setTitle(title);
        f.setCover("/api/uploads/cover.png");
        f.setSummary("摘要");
        f.setContent("正文内容");
        f.setType(type);
        f.setTopFlag(topFlag);
        f.setStatus(status);
        return f;
    }

    @Test
    void noticeFormMapsEveryEditableFieldOnCreate() {
        asAdmin();
        NoticeSvc s = new NoticeSvc();
        Notice created = s.create(noticeForm("公告标题", 2, 1, 1));

        assertEquals("公告标题", s.saved.getTitle());
        assertEquals("/api/uploads/cover.png", s.saved.getCover());
        assertEquals("摘要", s.saved.getSummary());
        assertEquals("正文内容", s.saved.getContent());
        assertEquals(2, s.saved.getType());
        assertEquals(1, s.saved.getTopFlag());
        assertEquals(1, s.saved.getStatus());
        // 系统字段由服务端维护
        assertEquals(0, s.saved.getViewCount());
        assertEquals(1L, s.saved.getPublishBy());
        assertNull(s.saved.getId());
        assertTrue(s.saved.getPublishTime() != null, "首次发布应写入发布时间");
        assertNull(s.saved.getCreateTime());
        assertEquals("公告标题", created.getTitle());
    }

    @Test
    void noticeFormMapsEditableFieldsAndPreservesPublishMetadataOnEdit() {
        asAdmin();
        NoticeSvc s = new NoticeSvc();
        s.current = new Notice();
        s.current.setId(9L);
        s.current.setStatus(1);
        s.current.setPublishTime(java.time.LocalDateTime.now().minusDays(1));

        s.update(9L, noticeForm("公告标题（新）", 3, 0, 2));

        assertEquals(9L, s.saved.getId(), "路径 id 优先于请求体");
        assertEquals("公告标题（新）", s.saved.getTitle());
        assertEquals("/api/uploads/cover.png", s.saved.getCover());
        assertEquals("摘要", s.saved.getSummary());
        assertEquals("正文内容", s.saved.getContent());
        assertEquals(3, s.saved.getType());
        assertEquals(0, s.saved.getTopFlag());
        assertEquals(2, s.saved.getStatus());
        assertNull(s.saved.getViewCount(), "阅读量不在表单里，交给更新策略保留");
        assertNull(s.saved.getPublishTime(), "重新发布不刷新首次发布时间");
        assertNull(s.saved.getPublishBy());
        assertNull(s.saved.getCreateTime());
    }

    @Test
    void noticeFormFirstPublishSetsPublishMetadata() {
        asAdmin();
        NoticeSvc s = new NoticeSvc();
        s.current = new Notice();
        s.current.setId(9L);
        s.current.setStatus(0);
        s.current.setPublishTime(null);

        s.update(9L, noticeForm("首次发布", 1, 0, 1));

        assertEquals(1L, s.saved.getPublishBy());
        assertTrue(s.saved.getPublishTime() != null);
    }

    // ---------------------------------------------------------------- 宠物

    static class PetSvc extends PetService {
        Pet current;
        Pet saved;
        Wrapper<Pet> updated;

        PetSvc() {
            super(mapper(SysUserMapper.class, name -> null));
        }

        @Override
        public boolean save(Pet row) {
            saved = row;
            return true;
        }

        @Override
        public boolean update(Pet row, Wrapper<Pet> query) {
            saved = row;
            updated = query;
            return true;
        }

        @Override
        public Pet requireOwned(Long id) {
            return current;
        }
    }

    static PetForm petForm() {
        PetForm f = new PetForm();
        f.setName("奶糖");
        f.setSpecies("猫");
        f.setBreed("英短");
        f.setGender(2);
        f.setBirthday(LocalDate.of(2022, 1, 15));
        f.setAgeMonth(0);
        f.setWeight(new BigDecimal("4.20"));
        f.setColor("蓝白");
        f.setIsNeutered(1);
        f.setVaccineStatus(2);
        f.setDewormFlag(1);
        f.setAvatar("/api/uploads/pet.png");
        f.setAllergy("海鲜");
        f.setMedicalHistory("无");
        f.setRemark("备注");
        return f;
    }

    @Test
    void petFormMapsEveryEditableFieldOnCreate() {
        asClient();
        PetSvc s = new PetSvc();
        Pet created = s.create(petForm());
        LocalDate birthday = LocalDate.of(2022, 1, 15);

        assertEquals(1L, s.saved.getUserId(), "归属只由登录态决定");
        assertEquals("奶糖", s.saved.getName());
        assertEquals("猫", s.saved.getSpecies());
        assertEquals("英短", s.saved.getBreed());
        assertEquals(2, s.saved.getGender());
        assertEquals(birthday, s.saved.getBirthday());
        assertEquals((int) ChronoUnit.MONTHS.between(birthday, LocalDate.now()), s.saved.getAgeMonth(),
                "有生日时月龄按生日推导");
        assertEquals(new BigDecimal("4.20"), s.saved.getWeight());
        assertEquals("蓝白", s.saved.getColor());
        assertEquals(1, s.saved.getIsNeutered());
        assertEquals(2, s.saved.getVaccineStatus());
        assertEquals(1, s.saved.getDewormFlag());
        assertEquals("/api/uploads/pet.png", s.saved.getAvatar());
        assertEquals("海鲜", s.saved.getAllergy());
        assertEquals("无", s.saved.getMedicalHistory());
        assertEquals("备注", s.saved.getRemark());
        assertNull(s.saved.getId());
        assertNull(s.saved.getCreateTime());
        assertEquals("奶糖", created.getName());
    }

    @Test
    void petFormClearsBirthdayAndWeightWhenSubmittedAsNull() {
        asClient();
        PetSvc s = new PetSvc();
        s.current = new Pet();
        s.current.setId(9L);
        s.current.setUserId(1L);
        s.current.setBirthday(LocalDate.of(2020, 1, 1));
        s.current.setAgeMonth(12);
        s.current.setWeight(new BigDecimal("3.00"));

        PetForm form = petForm();
        form.setBirthday(null);   // 显式清空
        form.setWeight(null);
        form.setAgeMonth(null);
        s.update(9L, form);

        assertEquals(9L, s.saved.getId(), "路径 id 优先于请求体");
        assertEquals(1L, s.saved.getUserId(), "归属不随请求变化");
        assertEquals("奶糖", s.saved.getName());
        assertEquals("猫", s.saved.getSpecies());
        assertEquals("英短", s.saved.getBreed());
        assertEquals(2, s.saved.getGender());
        assertNull(s.saved.getBirthday());
        assertNull(s.saved.getWeight());
        assertEquals(12, s.saved.getAgeMonth(), "生日清空后保留原月龄");
        assertEquals("蓝白", s.saved.getColor());
        assertEquals(1, s.saved.getIsNeutered());
        assertEquals(2, s.saved.getVaccineStatus());
        assertEquals(1, s.saved.getDewormFlag());
        assertEquals("/api/uploads/pet.png", s.saved.getAvatar());
        assertEquals("海鲜", s.saved.getAllergy());
        assertEquals("无", s.saved.getMedicalHistory());
        assertEquals("备注", s.saved.getRemark());
        assertNull(s.saved.getCreateTime(), "系统时间不来自请求");
        assertNull(s.saved.getUpdateTime());
        String set = ((AbstractWrapper<?, ?, ?>) s.updated).getSqlSet();
        assertTrue(set != null && set.contains("birthday") && set.contains("weight"),
                "显式 null 必须写进 SET 才能清空");
    }

    @Test
    void petFormOmittedBirthdayAndWeightKeepExistingValues() {
        asClient();
        PetSvc s = new PetSvc();
        s.current = new Pet();
        s.current.setId(9L);
        s.current.setUserId(1L);
        s.current.setBirthday(LocalDate.of(2020, 1, 1));
        s.current.setAgeMonth(12);
        s.current.setWeight(new BigDecimal("3.00"));

        PetForm form = new PetForm();
        form.setName("奶糖");
        form.setSpecies("猫");
        form.setAgeMonth(null);
        s.update(9L, form);

        assertEquals((int) ChronoUnit.MONTHS.between(LocalDate.of(2020, 1, 1), LocalDate.now()),
                s.saved.getAgeMonth(), "省略生日时按原生日推导月龄");
        String set = ((AbstractWrapper<?, ?, ?>) s.updated).getSqlSet();
        assertTrue(set == null || (!set.contains("birthday") && !set.contains("weight")),
                "省略字段不应进入 SET");
    }

    // ---------------------------------------------------------------- 病历

    static class ApptService extends AppointmentService {
        Appointment appointment;

        ApptService() {
            super(null, null, null, null, null, null, null, null, null, null);
        }

        @Override
        public Appointment lockForWrite(Long id) {
            return appointment;
        }
    }

    static class RecordSvc extends MedicalRecordService {
        MedicalRecord current;
        MedicalRecord saved;
        Wrapper<MedicalRecord> updated;

        RecordSvc(AppointmentService appointmentService) {
            super(appointmentService, null, null, null);
        }

        @Override
        public MedicalRecord getOne(Wrapper<MedicalRecord> query, boolean throwEx) {
            return current;
        }

        @Override
        public boolean save(MedicalRecord row) {
            row.setId(7L);
            saved = row;
            return true;
        }

        @Override
        public boolean update(MedicalRecord row, Wrapper<MedicalRecord> query) {
            saved = row;
            updated = query;
            return true;
        }

        @Override
        public MedicalRecord getById(Serializable id) {
            return saved == null ? current : saved;
        }
    }

    static Appointment acceptedAppointment() {
        Appointment a = new Appointment();
        a.setId(11L);
        a.setStatus(Appointment.ST_ACCEPTED);
        a.setUserId(1L);
        a.setPetId(2L);
        a.setDoctorId(5L);
        a.setDepartmentId(1L);
        a.setAppointmentDate(LocalDate.of(2026, 10, 1));
        return a;
    }

    static MedicalRecordForm recordForm() {
        MedicalRecordForm f = new MedicalRecordForm();
        f.setChiefComplaint("呕吐两天");
        f.setPhysicalExam("体温正常");
        f.setDiagnosis("急性肠胃炎");
        f.setPrescription("蒙脱石散");
        f.setTreatment("补液");
        f.setAdvice("清淡饮食");
        f.setNextVisitDate(LocalDate.of(2026, 10, 8));
        f.setImages("/api/uploads/xray.png");
        return f;
    }

    @Test
    void medicalRecordFormMapsClinicalFieldsAndDerivesOwnershipOnCreate() {
        asDoctor(5L);
        ApptService appt = new ApptService();
        appt.appointment = acceptedAppointment();
        RecordSvc s = new RecordSvc(appt);

        MedicalRecord created = s.saveOrUpdateForAppointment(11L, recordForm());

        assertEquals(7L, s.saved.getId());
        assertEquals(11L, s.saved.getAppointmentId());
        assertEquals(1L, s.saved.getUserId(), "归属来自预约单");
        assertEquals(2L, s.saved.getPetId());
        assertEquals(5L, s.saved.getDoctorId());
        assertEquals(1L, s.saved.getDepartmentId());
        assertEquals(LocalDate.of(2026, 10, 1), s.saved.getVisitDate(), "就诊日期来自预约单");
        assertTrue(s.saved.getRecordNo() != null && s.saved.getRecordNo().startsWith("MR"));
        assertEquals("呕吐两天", s.saved.getChiefComplaint());
        assertEquals("体温正常", s.saved.getPhysicalExam());
        assertEquals("急性肠胃炎", s.saved.getDiagnosis());
        assertEquals("蒙脱石散", s.saved.getPrescription());
        assertEquals("补液", s.saved.getTreatment());
        assertEquals("清淡饮食", s.saved.getAdvice());
        assertEquals(LocalDate.of(2026, 10, 8), s.saved.getNextVisitDate());
        assertEquals("/api/uploads/xray.png", s.saved.getImages());
        assertNull(s.saved.getCreateTime());
        assertEquals(7L, created.getId());
    }

    @Test
    void medicalRecordFormClearsNextVisitDateWhenSubmittedAsNull() {
        asDoctor(5L);
        ApptService appt = new ApptService();
        appt.appointment = acceptedAppointment();
        RecordSvc s = new RecordSvc(appt);
        s.current = new MedicalRecord();
        s.current.setId(7L);
        s.current.setAppointmentId(11L);
        s.current.setNextVisitDate(LocalDate.of(2026, 10, 8));

        MedicalRecordForm form = recordForm();
        form.setNextVisitDate(null);
        form.setDiagnosis("复查正常");
        s.saveOrUpdateForAppointment(11L, form);

        assertEquals(7L, s.saved.getId());
        assertEquals(11L, s.saved.getAppointmentId());
        assertEquals("呕吐两天", s.saved.getChiefComplaint());
        assertEquals("体温正常", s.saved.getPhysicalExam());
        assertEquals("复查正常", s.saved.getDiagnosis());
        assertEquals("蒙脱石散", s.saved.getPrescription());
        assertEquals("补液", s.saved.getTreatment());
        assertEquals("清淡饮食", s.saved.getAdvice());
        assertNull(s.saved.getNextVisitDate());
        assertEquals("/api/uploads/xray.png", s.saved.getImages());
        assertEquals(LocalDate.of(2026, 10, 1), s.saved.getVisitDate(), "就诊日期仍取预约单");
        assertNull(s.saved.getUserId(), "修订不重写归属与编号字段");
        assertNull(s.saved.getPetId());
        assertNull(s.saved.getDoctorId());
        assertNull(s.saved.getDepartmentId());
        assertNull(s.saved.getRecordNo(), "修订不重新生成病历编号");
        assertNull(s.saved.getCreateTime(), "系统时间不来自请求");
        assertNull(s.saved.getUpdateTime());
        String set = ((AbstractWrapper<?, ?, ?>) s.updated).getSqlSet();
        assertTrue(set != null && set.contains("next_visit_date"), "显式 null 必须写进 SET 才能清空");
    }

    @Test
    void medicalRecordFormOmittedNextVisitDateKeepsExistingValue() {
        asDoctor(5L);
        ApptService appt = new ApptService();
        appt.appointment = acceptedAppointment();
        RecordSvc s = new RecordSvc(appt);
        s.current = new MedicalRecord();
        s.current.setId(7L);
        s.current.setAppointmentId(11L);

        MedicalRecordForm form = new MedicalRecordForm();
        form.setDiagnosis("继续观察");
        s.saveOrUpdateForAppointment(11L, form);

        String set = ((AbstractWrapper<?, ?, ?>) s.updated).getSqlSet();
        assertTrue(set == null || !set.contains("next_visit_date"), "省略复诊日期不应进入 SET");
    }
}
