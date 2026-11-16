package com.petclinic.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.AbstractWrapper;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.petclinic.common.BizException;
import com.petclinic.common.PageResult;
import com.petclinic.config.AppProperties;
import com.petclinic.dto.AppointmentForm;
import com.petclinic.dto.AppointmentQuery;
import com.petclinic.dto.PageQuery;
import com.petclinic.entity.Appointment;
import com.petclinic.entity.ConsultSession;
import com.petclinic.entity.Department;
import com.petclinic.entity.Doctor;
import com.petclinic.entity.DoctorSchedule;
import com.petclinic.entity.MedicalRecord;
import com.petclinic.entity.Pet;
import com.petclinic.entity.SysUser;
import com.petclinic.mapper.AppointmentMapper;
import com.petclinic.mapper.ConsultSessionMapper;
import com.petclinic.mapper.DepartmentMapper;
import com.petclinic.mapper.DoctorMapper;
import com.petclinic.mapper.DoctorScheduleMapper;
import com.petclinic.mapper.MedicalRecordMapper;
import com.petclinic.mapper.PetMapper;
import com.petclinic.mapper.SysUserMapper;
import com.petclinic.security.LoginUser;
import com.petclinic.security.UserContext;
import com.petclinic.vo.AppointmentVo;
import com.petclinic.vo.PetDisplayVo;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * AppointmentService 的状态机、身份过滤、锁内复核与 VO 组装的单元覆盖。
 *
 * <p>每个用例都断言业务结果（code/message、状态、余量或返回字段），而不是只跑一遍代码。
 * Mapper 是 Mockito mock，baseMapper 通过 ReflectionTestUtils 注入父类字段；
 * UserContext 是 ThreadLocal，用例结束必须清理。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AppointmentServiceCoverageTest {

    @Mock
    private AppointmentMapper appointmentMapper;
    @Mock
    private PetService petService;
    @Mock
    private PetMapper petMapper;
    @Mock
    private DoctorMapper doctorMapper;
    @Mock
    private DepartmentMapper departmentMapper;
    @Mock
    private DoctorScheduleMapper scheduleMapper;
    @Mock
    private SysUserMapper sysUserMapper;
    @Mock
    private ConsultSessionMapper sessionMapper;
    @Mock
    private MedicalRecordMapper recordMapper;
    @Mock
    private AppProperties props;

    private AppointmentService service;

    @BeforeAll
    static void initTableInfo() {
        MybatisConfiguration configuration = new MybatisConfiguration();
        for (Class<?> type : List.of(Appointment.class, DoctorSchedule.class, Doctor.class,
                Department.class, SysUser.class, ConsultSession.class, MedicalRecord.class)) {
            TableInfoHelper.initTableInfo(new MapperBuilderAssistant(configuration, "test"), type);
        }
    }

    @BeforeEach
    void setUp() {
        service = new AppointmentService(petService, petMapper, doctorMapper, departmentMapper,
                scheduleMapper, sysUserMapper, sessionMapper, recordMapper, props);
        ReflectionTestUtils.setField(service, "baseMapper", appointmentMapper);

        when(props.getPayTimeoutMinutes()).thenReturn(30);
        when(petService.requireOwned(any())).thenReturn(pet(1L, 7L));
        when(appointmentMapper.insert(any(Appointment.class))).thenReturn(1);
        when(appointmentMapper.update(any(), any())).thenReturn(1);
        when(appointmentMapper.selectCount(any())).thenReturn(0L);
        when(appointmentMapper.selectList(any())).thenReturn(List.of());
        when(appointmentMapper.selectUnpaidOverdueIds(any())).thenReturn(List.of());
        when(appointmentMapper.selectStaleVisitIds()).thenReturn(List.of());
        doAnswer(invocation -> {
            Page<Appointment> page = invocation.getArgument(0);
            page.setRecords(List.of());
            page.setTotal(0);
            return page;
        }).when(appointmentMapper).selectPage(any(), any());
        when(scheduleMapper.tryOccupy(any())).thenReturn(1);
        when(scheduleMapper.selectLastQueueNoForUpdate(any())).thenReturn(1);
        when(scheduleMapper.release(any())).thenReturn(1);
        when(petMapper.selectHistoryDisplay(anyCollection())).thenReturn(List.of());
        when(doctorMapper.selectBatchIds(anyCollection())).thenReturn(List.of());
        when(departmentMapper.selectBatchIds(anyCollection())).thenReturn(List.of());
        when(sysUserMapper.selectBatchIds(anyCollection())).thenReturn(List.of());
        when(sessionMapper.selectList(any())).thenReturn(List.of());
        when(recordMapper.selectList(any())).thenReturn(List.of());
    }

    @AfterEach
    void tearDown() {
        UserContext.clear();
    }

    // ---------------------------------------------------------------- 下单

    @Test
    void createRejectsUnknownDoctor() {
        when(doctorMapper.selectById(2L)).thenReturn(null);

        BizException e = biz(() -> service.create(form(1L, 2L, 4L, "发热")));

        assertThat(e.getCode()).isEqualTo(404);
        assertThat(e.getMessage()).contains("医生不存在");
        verify(appointmentMapper, never()).insert(any(Appointment.class));
    }

    @Test
    void createRejectsStoppedDoctor() {
        Doctor doctor = doctor(2L, 3L, 0, new BigDecimal("50"));
        when(doctorMapper.selectById(2L)).thenReturn(doctor);

        BizException e = biz(() -> service.create(form(1L, 2L, 4L, "发热")));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("该医生已停诊");
        verify(scheduleMapper, never()).selectByIdForUpdate(any());
    }

    @Test
    void createRejectsMissingSymptom() {
        when(doctorMapper.selectById(2L)).thenReturn(doctor(2L, 3L, 1, new BigDecimal("50")));

        assertThat(biz(() -> service.create(form(1L, 2L, 4L, null))).getMessage())
                .contains("请描述症状");
        assertThat(biz(() -> service.create(form(1L, 2L, 4L, "   "))).getMessage())
                .contains("请描述症状");
        verify(scheduleMapper, never()).selectByIdForUpdate(any());
    }

    @Test
    void createRejectsUnknownSchedule() {
        when(doctorMapper.selectById(2L)).thenReturn(doctor(2L, 3L, 1, new BigDecimal("50")));
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(null);

        BizException e = biz(() -> service.create(form(1L, 2L, 4L, "发热")));

        assertThat(e.getCode()).isEqualTo(404);
        assertThat(e.getMessage()).contains("排班时段不存在");
    }

    @Test
    void createRejectsScheduleOfAnotherDoctor() {
        when(doctorMapper.selectById(2L)).thenReturn(doctor(2L, 3L, 1, new BigDecimal("50")));
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(schedule(4L, 99L, LocalDate.now().plusDays(1)));

        BizException e = biz(() -> service.create(form(1L, 2L, 4L, "发热")));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("所选时段不属于该医生");
    }

    @Test
    void createRejectsStoppedSchedule() {
        when(doctorMapper.selectById(2L)).thenReturn(doctor(2L, 3L, 1, new BigDecimal("50")));
        DoctorSchedule schedule = schedule(4L, 2L, LocalDate.now().plusDays(1));
        schedule.setStatus(0);
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(schedule);

        BizException e = biz(() -> service.create(form(1L, 2L, 4L, "发热")));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("该时段已停诊");
    }

    @Test
    void createRejectsPastOrAlreadyEndedSchedule() {
        when(doctorMapper.selectById(2L)).thenReturn(doctor(2L, 3L, 1, new BigDecimal("50")));

        DoctorSchedule past = schedule(4L, 2L, LocalDate.now().minusDays(1));
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(past);
        BizException pastError = biz(() -> service.create(form(1L, 2L, 4L, "发热")));
        assertThat(pastError.getCode()).isEqualTo(400);
        assertThat(pastError.getMessage()).contains("该时段已过期");

        DoctorSchedule ended = schedule(4L, 2L, LocalDate.now());
        ended.setStartTime(LocalTime.MIN);
        ended.setEndTime(LocalTime.MIN);
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(ended);
        BizException endedError = biz(() -> service.create(form(1L, 2L, 4L, "发热")));
        assertThat(endedError.getCode()).isEqualTo(400);
        assertThat(endedError.getMessage()).contains("门诊已经结束");
    }

    @Test
    void createRejectsDuplicatePetAndFullSchedule() {
        when(doctorMapper.selectById(2L)).thenReturn(doctor(2L, 3L, 1, new BigDecimal("50")));
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(schedule(4L, 2L, LocalDate.now().plusDays(1)));

        when(appointmentMapper.selectCount(any())).thenReturn(1L);
        BizException duplicate = biz(() -> service.create(form(1L, 2L, 4L, "发热")));
        assertThat(duplicate.getCode()).isEqualTo(400);
        assertThat(duplicate.getMessage()).contains("该宠物已预约此时段");
        verify(scheduleMapper, never()).tryOccupy(any());

        when(appointmentMapper.selectCount(any())).thenReturn(0L);
        when(scheduleMapper.tryOccupy(4L)).thenReturn(0);
        BizException full = biz(() -> service.create(form(1L, 2L, 4L, "发热")));
        assertThat(full.getCode()).isEqualTo(400);
        assertThat(full.getMessage()).contains("号源已约满");
    }

    @Test
    void createRejectsMissingQueueCounter() {
        when(doctorMapper.selectById(2L)).thenReturn(doctor(2L, 3L, 1, new BigDecimal("50")));
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(schedule(4L, 2L, LocalDate.now().plusDays(1)));
        when(scheduleMapper.selectLastQueueNoForUpdate(4L)).thenReturn(null);

        BizException e = biz(() -> service.create(form(1L, 2L, 4L, "发热")));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("号源状态异常");
        verify(appointmentMapper, never()).insert(any(Appointment.class));
    }

    @Test
    void createBuildsOrderFromScheduleAndEnrichesVo() {
        Doctor doctor = doctor(2L, 3L, 1, new BigDecimal("50"));
        doctor.setName("陈明远");
        doctor.setTitle("主任医师");
        doctor.setAvatar("doctor.png");
        when(doctorMapper.selectById(2L)).thenReturn(doctor);
        when(doctorMapper.selectBatchIds(anyCollection())).thenReturn(List.of(doctor));

        DoctorSchedule schedule = schedule(4L, 2L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(schedule);
        when(scheduleMapper.selectLastQueueNoForUpdate(4L)).thenReturn(7);

        PetDisplayVo petDisplay = new PetDisplayVo();
        petDisplay.setId(1L);
        petDisplay.setName("团子");
        petDisplay.setSpecies("猫");
        petDisplay.setBreed("狸花");
        petDisplay.setAvatar("pet.png");
        when(petMapper.selectHistoryDisplay(anyCollection())).thenReturn(List.of(petDisplay));

        Department department = new Department();
        department.setId(3L);
        department.setName("内科");
        when(departmentMapper.selectBatchIds(anyCollection())).thenReturn(List.of(department));

        ConsultSession session = new ConsultSession();
        session.setId(501L);
        session.setAppointmentId(100L);
        when(sessionMapper.selectList(any())).thenReturn(List.of(session));
        MedicalRecord record = new MedicalRecord();
        record.setId(601L);
        record.setAppointmentId(100L);
        when(recordMapper.selectList(any())).thenReturn(List.of(record));

        when(appointmentMapper.insert(any(Appointment.class))).thenAnswer(invocation -> {
            Appointment inserted = invocation.getArgument(0);
            inserted.setId(100L);
            return 1;
        });

        AppointmentVo vo = service.create(form(1L, 2L, 4L, "  发热  "));

        assertThat(vo.getId()).isEqualTo(100L);
        assertThat(vo.getOrderNo()).startsWith("PC").matches("PC\\d{25}");
        assertThat(vo.getUserId()).isEqualTo(7L);
        assertThat(vo.getPetId()).isEqualTo(1L);
        assertThat(vo.getDoctorId()).isEqualTo(2L);
        assertThat(vo.getDepartmentId()).isEqualTo(3L);
        assertThat(vo.getScheduleId()).isEqualTo(4L);
        assertThat(vo.getConsultType()).isEqualTo(Appointment.CT_VISIT);
        assertThat(vo.getAppointmentDate()).isEqualTo(schedule.getWorkDate());
        assertThat(vo.getPeriod()).isEqualTo(1);
        assertThat(vo.getQueueNo()).isEqualTo(7);
        assertThat(vo.getSymptom()).isEqualTo("发热");
        assertThat(vo.getImages()).isNull();
        assertThat(vo.getAmount()).isEqualByComparingTo("50");
        assertThat(vo.getPayStatus()).isEqualTo(Appointment.PAY_NONE);
        assertThat(vo.getStatus()).isEqualTo(Appointment.ST_PENDING);
        assertThat(vo.getIsReviewed()).isZero();
        assertThat(vo.getPetName()).isEqualTo("团子");
        assertThat(vo.getPetSpecies()).isEqualTo("猫");
        assertThat(vo.getPetBreed()).isEqualTo("狸花");
        assertThat(vo.getPetAvatar()).isEqualTo("pet.png");
        assertThat(vo.getDoctorName()).isEqualTo("陈明远");
        assertThat(vo.getDoctorTitle()).isEqualTo("主任医师");
        assertThat(vo.getDepartmentName()).isEqualTo("内科");
        assertThat(vo.getSessionId()).isEqualTo(501L);
        assertThat(vo.getRecordId()).isEqualTo(601L);
        assertThat(vo.getUserNickname()).isNull();

        verify(scheduleMapper).tryOccupy(4L);
        verify(appointmentMapper).insert(any(Appointment.class));
        verify(sysUserMapper, never()).selectBatchIds(anyCollection());
    }

    // ---------------------------------------------------------------- 支付

    @Test
    void payRejectsMissingOrForeignOrder() {
        UserContext.set(client(7L));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(null);
        assertThat(biz(() -> service.pay(1L)).getCode()).isEqualTo(404);

        Appointment foreign = pendingAppointment(1L, 8L);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(foreign);
        BizException e = biz(() -> service.pay(1L));
        assertThat(e.getCode()).isEqualTo(404);
        assertThat(e.getMessage()).contains("预约记录不存在");
        verify(appointmentMapper, never()).update(any(), any());
    }

    @Test
    void payRejectsNonPendingAndExpiredOrders() {
        UserContext.set(client(7L));
        Appointment accepted = pendingAppointment(1L, 7L);
        accepted.setStatus(Appointment.ST_ACCEPTED);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(accepted);

        BizException statusError = biz(() -> service.pay(1L));
        assertThat(statusError.getCode()).isEqualTo(400);
        assertThat(statusError.getMessage()).contains("当前状态不能支付");

        Appointment expired = pendingAppointment(1L, 7L);
        expired.setCreateTime(LocalDateTime.now().minusMinutes(31));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(expired);
        BizException expiredError = biz(() -> service.pay(1L));
        assertThat(expiredError.getCode()).isEqualTo(400);
        assertThat(expiredError.getMessage()).contains("30 分钟未支付");
        verify(appointmentMapper, never()).update(any(), any());
    }

    @Test
    void payReturnsAlreadyPaidOrderWithoutWriting() {
        UserContext.set(client(7L));
        Appointment paid = pendingAppointment(1L, 7L);
        paid.setPayStatus(Appointment.PAY_PAID);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(paid);

        AppointmentVo vo = service.pay(1L);

        assertThat(vo.getPayStatus()).isEqualTo(Appointment.PAY_PAID);
        verify(appointmentMapper, never()).update(any(), any());
    }

    @Test
    void payFailsWhenConditionalUpdateMisses() {
        UserContext.set(client(7L));
        Appointment appointment = pendingAppointment(1L, 7L);
        appointment.setCreateTime(null);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(appointment);
        when(appointmentMapper.update(any(), any())).thenReturn(0);

        BizException e = biz(() -> service.pay(1L));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("订单状态已变化");
    }

    @Test
    @SuppressWarnings("unchecked")
    void payMarksOrderPaid() {
        UserContext.set(client(7L));
        Appointment appointment = pendingAppointment(1L, 7L);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(appointment);

        AppointmentVo vo = service.pay(1L);

        assertThat(vo.getPayStatus()).isEqualTo(Appointment.PAY_PAID);
        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue()))
                .contains(Appointment.PAY_PAID, "MOCK", Appointment.ST_PENDING, 1L);
    }

    // ---------------------------------------------------------------- 取消

    @Test
    void cancelByUserRejectsCancelledAcceptedAndLostUpdate() {
        UserContext.set(client(7L));

        Appointment cancelled = pendingAppointment(1L, 7L);
        cancelled.setStatus(Appointment.ST_CANCELLED);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(cancelled);
        assertThat(biz(() -> service.cancelByUser(1L, null)).getMessage()).contains("该预约已取消");

        Appointment accepted = pendingAppointment(1L, 7L);
        accepted.setStatus(Appointment.ST_ACCEPTED);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(accepted);
        assertThat(biz(() -> service.cancelByUser(1L, null)).getMessage()).contains("已进入接诊流程");

        Appointment pending = pendingAppointment(1L, 7L);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(pending);
        when(appointmentMapper.update(any(), any())).thenReturn(0);
        assertThat(biz(() -> service.cancelByUser(1L, "反悔了")).getMessage()).contains("该预约已取消");
        verify(scheduleMapper, never()).release(any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void cancelByUserRefundsPaidOrderAndReleasesSlot() {
        UserContext.set(client(7L));
        Appointment paid = pendingAppointment(1L, 7L);
        paid.setPayStatus(Appointment.PAY_PAID);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(paid);

        service.cancelByUser(1L, "反悔了");

        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue()))
                .contains(Appointment.ST_CANCELLED, "反悔了", "USER", Appointment.PAY_REFUNDED);
        verify(scheduleMapper).release(4L);
    }

    @Test
    void cancelByUserWithoutScheduleDoesNotReleaseSlot() {
        UserContext.set(client(7L));
        Appointment pending = pendingAppointment(1L, 7L);
        pending.setScheduleId(null);
        // 已支付但就诊日为空的单不触发"已过就诊日"分支，取消仍按正常退款处理
        pending.setPayStatus(Appointment.PAY_PAID);
        pending.setAppointmentDate(null);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(pending);

        service.cancelByUser(1L, null);

        verify(appointmentMapper).update(any(), any());
        verify(scheduleMapper, never()).release(any());
    }

    @Test
    void createAcceptsTodayBeforeSlotEnds() {
        when(doctorMapper.selectById(2L)).thenReturn(doctor(2L, 3L, 1, new BigDecimal("50")));
        DoctorSchedule today = schedule(4L, 2L, LocalDate.now());
        today.setStartTime(LocalTime.MIN);
        today.setEndTime(LocalTime.MAX);
        when(scheduleMapper.selectByIdForUpdate(4L)).thenReturn(today);
        when(scheduleMapper.selectLastQueueNoForUpdate(4L)).thenReturn(5);

        AppointmentVo vo = service.create(form(1L, 2L, 4L, "发热"));

        assertThat(vo.getAppointmentDate()).isEqualTo(LocalDate.now());
        assertThat(vo.getQueueNo()).isEqualTo(5);
        assertThat(vo.getStatus()).isEqualTo(Appointment.ST_PENDING);
        verify(scheduleMapper).tryOccupy(4L);
    }

    @Test
    void cancelByUserMarksOverduePaidOrderAsMissed() {
        UserContext.set(client(7L));
        Appointment overdue = pendingAppointment(1L, 7L);
        overdue.setPayStatus(Appointment.PAY_PAID);
        overdue.setAppointmentDate(LocalDate.now().minusDays(1));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(overdue);

        Throwable thrown = catchThrowable(() -> service.cancelByUser(1L, null));

        assertThat(thrown).isInstanceOf(AppointmentService.VisitOverdueException.class);
        assertThat(thrown.getMessage()).contains("已标记未到诊");
        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue())).contains(Appointment.ST_MISSED);
    }

    @Test
    @SuppressWarnings("unchecked")
    void cancelByStaffUsesOperatorRole() {
        Appointment appointment = pendingAppointment(1L, 7L);
        appointment.setScheduleId(null);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(appointment);

        UserContext.set(doctor(2L));
        service.cancelByStaff(1L, "临时停诊");
        ArgumentCaptor<Wrapper<Appointment>> doctorCaptor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper, times(1)).update(isNull(), doctorCaptor.capture());
        assertThat(values(doctorCaptor.getValue())).contains("临时停诊", "DOCTOR");

        UserContext.set(admin());
        service.cancelByStaff(1L, "前台改约");
        ArgumentCaptor<Wrapper<Appointment>> adminCaptor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper, times(2)).update(isNull(), adminCaptor.capture());
        assertThat(values(adminCaptor.getValue())).contains("前台改约", "ADMIN");
    }

    @Test
    void cancelByStaffRejectsOtherDoctorAndMissingOrder() {
        Appointment appointment = pendingAppointment(1L, 7L);
        appointment.setDoctorId(2L);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(appointment);

        UserContext.set(doctor(99L));
        BizException forbidden = biz(() -> service.cancelByStaff(1L, null));
        assertThat(forbidden.getCode()).isEqualTo(403);
        assertThat(forbidden.getMessage()).contains("只能处理自己的接诊单");

        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(null);
        BizException missing = biz(() -> service.cancelByStaff(1L, null));
        assertThat(missing.getCode()).isEqualTo(404);
        verify(appointmentMapper, never()).update(any(), any());
    }

    // ---------------------------------------------------------------- 接诊 / 完成

    @Test
    void acceptEnforcesDoctorOwnershipAndState() {
        Appointment appointment = pendingAppointment(1L, 7L);
        appointment.setDoctorId(2L);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(appointment);

        UserContext.set(admin());
        BizException adminError = biz(() -> service.accept(1L));
        assertThat(adminError.getCode()).isEqualTo(403);
        assertThat(adminError.getMessage()).contains("仅限医生账号");

        UserContext.set(doctor(99L));
        BizException foreignError = biz(() -> service.accept(1L));
        assertThat(foreignError.getCode()).isEqualTo(403);
        assertThat(foreignError.getMessage()).contains("只能处理自己的接诊单");

        UserContext.set(doctor(2L));
        Appointment accepted = pendingAppointment(1L, 7L);
        accepted.setDoctorId(2L);
        accepted.setStatus(Appointment.ST_ACCEPTED);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(accepted);
        assertThat(biz(() -> service.accept(1L)).getMessage()).contains("只有待接诊");

        Appointment unpaid = pendingAppointment(1L, 7L);
        unpaid.setDoctorId(2L);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(unpaid);
        assertThat(biz(() -> service.accept(1L)).getMessage()).contains("尚未支付");

        verify(appointmentMapper, never()).update(any(), any());
    }

    @Test
    void acceptMarksOverdueOrderAsMissed() {
        UserContext.set(doctor(2L));
        Appointment overdue = pendingAppointment(1L, 7L);
        overdue.setDoctorId(2L);
        overdue.setPayStatus(Appointment.PAY_PAID);
        overdue.setAppointmentDate(LocalDate.now().minusDays(1));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(overdue);

        Throwable thrown = catchThrowable(() -> service.accept(1L));

        assertThat(thrown).isInstanceOf(AppointmentService.VisitOverdueException.class);
        verify(appointmentMapper).update(any(), any());
    }

    @Test
    void acceptFailsWhenConditionalUpdateMisses() {
        UserContext.set(doctor(2L));
        Appointment paid = pendingAppointment(1L, 7L);
        paid.setDoctorId(2L);
        paid.setPayStatus(Appointment.PAY_PAID);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(paid);
        when(appointmentMapper.update(any(), any())).thenReturn(0);

        BizException e = biz(() -> service.accept(1L));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("状态已变化");
    }

    @Test
    @SuppressWarnings("unchecked")
    void acceptMarksOrderAccepted() {
        UserContext.set(doctor(2L));
        Appointment paid = pendingAppointment(1L, 7L);
        paid.setDoctorId(2L);
        paid.setPayStatus(Appointment.PAY_PAID);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(paid);

        service.accept(1L);

        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue())).contains(Appointment.ST_ACCEPTED, 1L);
    }

    @Test
    void finishEnforcesDoctorAndAcceptedState() {
        Appointment accepted = pendingAppointment(1L, 7L);
        accepted.setDoctorId(2L);
        accepted.setStatus(Appointment.ST_ACCEPTED);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(accepted);

        UserContext.set(admin());
        BizException adminError = biz(() -> service.finish(1L));
        assertThat(adminError.getCode()).isEqualTo(403);

        UserContext.set(doctor(2L));
        Appointment pending = pendingAppointment(1L, 7L);
        pending.setDoctorId(2L);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(pending);
        assertThat(biz(() -> service.finish(1L)).getMessage()).contains("请先接诊再结束");

        when(appointmentMapper.update(any(), any())).thenReturn(0);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(accepted);
        BizException missed = biz(() -> service.finish(1L));
        assertThat(missed.getCode()).isEqualTo(400);
        assertThat(missed.getMessage()).contains("状态已变化");
        verify(doctorMapper, never()).incrementAppointmentCount(any());
    }

    @Test
    void finishMarksDoneAndIncrementsDoctorCount() {
        UserContext.set(doctor(2L));
        Appointment accepted = pendingAppointment(1L, 7L);
        accepted.setDoctorId(2L);
        accepted.setStatus(Appointment.ST_ACCEPTED);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(accepted);

        service.finish(1L);

        verify(appointmentMapper).update(any(), any());
        verify(doctorMapper).incrementAppointmentCount(2L);
    }

    // ---------------------------------------------------------------- 查询

    @Test
    void pageMineFiltersByCurrentUserAndOptionalStatus() {
        UserContext.set(client(7L));
        Appointment row = pendingAppointment(1L, 7L);
        row.setId(10L);
        doAnswer(invocation -> {
            Page<Appointment> page = invocation.getArgument(0);
            page.setRecords(List.of(row));
            page.setTotal(1);
            return page;
        }).when(appointmentMapper).selectPage(any(), any());

        PageResult<AppointmentVo> all = service.pageMine(null, new PageQuery());
        assertThat(all.getTotal()).isEqualTo(1);
        assertThat(all.getRecords()).singleElement().satisfies(vo -> {
            assertThat(vo.getId()).isEqualTo(10L);
            assertThat(vo.getUserNickname()).isNull();
        });

        PageResult<AppointmentVo> filtered = service.pageMine(1, new PageQuery());
        assertThat(filtered.getRecords()).hasSize(1);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper, times(2)).selectPage(any(), captor.capture());
        assertThat(values(captor.getAllValues().get(0))).contains(7L).doesNotContain(1);
        assertThat(values(captor.getAllValues().get(1))).contains(7L, 1);
    }

    @Test
    @SuppressWarnings("unchecked")
    void listByUserForAdminBuildsPatientSideFieldsAndHonoursLimit() {
        Appointment first = pendingAppointment(100L, 7L);
        first.setPetId(1L);
        first.setDoctorId(2L);
        first.setDepartmentId(3L);
        first.setCreateTime(LocalDateTime.now());
        Appointment second = pendingAppointment(101L, 8L);
        second.setPetId(99L);
        second.setDoctorId(98L);
        second.setDepartmentId(97L);
        second.setCreateTime(null);
        when(appointmentMapper.selectList(any())).thenReturn(List.of(first, second));

        PetDisplayVo petDisplay = new PetDisplayVo();
        petDisplay.setId(1L);
        petDisplay.setName("团子");
        petDisplay.setSpecies("猫");
        petDisplay.setBreed("狸花");
        petDisplay.setAvatar("pet.png");
        when(petMapper.selectHistoryDisplay(anyCollection())).thenReturn(List.of(petDisplay));

        Doctor doctor = doctor(2L, 3L, 1, new BigDecimal("50"));
        doctor.setName("陈明远");
        doctor.setTitle("主任医师");
        doctor.setAvatar("doctor.png");
        when(doctorMapper.selectBatchIds(anyCollection())).thenReturn(List.of(doctor));

        Department department = new Department();
        department.setId(3L);
        department.setName("内科");
        when(departmentMapper.selectBatchIds(anyCollection())).thenReturn(List.of(department));

        SysUser owner = new SysUser();
        owner.setId(7L);
        owner.setNickname("小王");
        owner.setPhone("13800000000");
        when(sysUserMapper.selectBatchIds(anyCollection())).thenReturn(List.of(owner));

        ConsultSession session = new ConsultSession();
        session.setId(501L);
        session.setAppointmentId(100L);
        when(sessionMapper.selectList(any())).thenReturn(List.of(session));
        MedicalRecord record = new MedicalRecord();
        record.setId(601L);
        record.setAppointmentId(100L);
        when(recordMapper.selectList(any())).thenReturn(List.of(record));

        List<AppointmentVo> rows = service.listByUserForAdmin(7L, 999);

        assertThat(rows).hasSize(2);
        AppointmentVo enriched = rows.get(0);
        assertThat(enriched.getPetName()).isEqualTo("团子");
        assertThat(enriched.getDoctorName()).isEqualTo("陈明远");
        assertThat(enriched.getDepartmentName()).isEqualTo("内科");
        assertThat(enriched.getUserNickname()).isEqualTo("小王");
        assertThat(enriched.getUserPhone()).isEqualTo("13800000000");
        assertThat(enriched.getSessionId()).isEqualTo(501L);
        assertThat(enriched.getRecordId()).isEqualTo(601L);
        assertThat(enriched.getPayDeadline()).isEqualTo(first.getCreateTime().plusMinutes(30));
        AppointmentVo missing = rows.get(1);
        assertThat(missing.getPetName()).isNull();
        assertThat(missing.getDoctorName()).isNull();
        assertThat(missing.getDepartmentName()).isNull();
        assertThat(missing.getUserNickname()).isNull();
        assertThat(missing.getPayDeadline()).isNull();

        service.listByUserForAdmin(7L, 0);

        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper, times(2)).selectList(captor.capture());
        assertThat(sql(captor.getAllValues().get(0))).contains("LIMIT 100");
        assertThat(sql(captor.getAllValues().get(1))).contains("LIMIT 1");
    }

    @Test
    void listByUserForAdminReturnsEmptyForNoRows() {
        when(appointmentMapper.selectList(any())).thenReturn(List.of());

        assertThat(service.listByUserForAdmin(7L, 10)).isEmpty();
        verify(petMapper, never()).selectHistoryDisplay(anyCollection());
    }

    @Test
    @SuppressWarnings("unchecked")
    void pageForStaffAppliesAdminFiltersAndDayOverride() {
        UserContext.set(admin());
        LocalDate start = LocalDate.now();
        LocalDate end = start.plusDays(3);
        AppointmentQuery all = new AppointmentQuery();
        all.setPageNum(2);
        all.setPageSize(20);
        all.setDoctorId(2L);
        all.setUserId(7L);
        all.setStatus(1);
        all.setPayStatus(1);
        all.setStart(start);
        all.setEnd(end);
        Appointment row = pendingAppointment(1L, 7L);
        row.setId(10L);
        doAnswer(invocation -> {
            Page<Appointment> page = invocation.getArgument(0);
            page.setRecords(List.of(row));
            page.setTotal(1);
            return page;
        }).when(appointmentMapper).selectPage(any(), any());

        PageResult<AppointmentVo> result = service.pageForStaff(all);

        assertThat(result.getCurrent()).isEqualTo(2);
        assertThat(result.getSize()).isEqualTo(20);
        assertThat(result.getRecords()).singleElement().satisfies(vo -> {
            assertThat(vo.getId()).isEqualTo(10L);
            assertThat(vo.getUserNickname()).isNull();
        });

        LocalDate day = LocalDate.now().plusDays(5);
        LocalDate ignoredStart = LocalDate.now();
        LocalDate ignoredEnd = LocalDate.now().plusDays(1);
        AppointmentQuery byDay = new AppointmentQuery();
        byDay.setDay(day);
        byDay.setStart(ignoredStart);
        byDay.setEnd(ignoredEnd);
        service.pageForStaff(byDay);

        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper, times(2)).selectPage(any(), captor.capture());
        List<Object> firstValues = values(captor.getAllValues().get(0));
        assertThat(firstValues).contains(2L, 7L, 1, start, end);
        List<Object> dayValues = values(captor.getAllValues().get(1));
        assertThat(dayValues).contains(day).doesNotContain(ignoredStart, ignoredEnd);
    }

    @Test
    @SuppressWarnings("unchecked")
    void pageForStaffForcesDoctorToOwnOrders() {
        UserContext.set(doctor(77L));
        AppointmentQuery query = new AppointmentQuery();
        query.setDoctorId(999L);
        query.setDay(LocalDate.now().plusDays(2));
        doAnswer(invocation -> {
            Page<Appointment> page = invocation.getArgument(0);
            page.setRecords(List.of());
            page.setTotal(0);
            return page;
        }).when(appointmentMapper).selectPage(any(), any());

        PageResult<AppointmentVo> result = service.pageForStaff(query);

        assertThat(result.getRecords()).isEmpty();
        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).selectPage(any(), captor.capture());
        assertThat(values(captor.getValue())).contains(77L).doesNotContain(999L);
    }

    @Test
    @SuppressWarnings("unchecked")
    void pageForStaffWithoutFiltersLeavesWrapperEmpty() {
        UserContext.set(admin());
        doAnswer(invocation -> {
            Page<Appointment> page = invocation.getArgument(0);
            page.setRecords(List.of());
            page.setTotal(0);
            return page;
        }).when(appointmentMapper).selectPage(any(), any());

        PageResult<AppointmentVo> result = service.pageForStaff(new AppointmentQuery());

        assertThat(result.getRecords()).isEmpty();
        assertThat(result.getTotal()).isZero();
        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).selectPage(any(), captor.capture());
        assertThat(values(captor.getValue())).isEmpty();
    }

    @Test
    void detailAppliesClientOwnership() {
        Appointment mine = pendingAppointment(1L, 7L);
        when(appointmentMapper.selectById(1L)).thenReturn(mine);
        UserContext.set(client(7L));

        AppointmentVo vo = service.detail(1L);

        assertThat(vo.getId()).isEqualTo(1L);
        assertThat(vo.getUserNickname()).isNull();

        when(appointmentMapper.selectById(2L)).thenReturn(pendingAppointment(2L, 8L));
        BizException foreign = biz(() -> service.detail(2L));
        assertThat(foreign.getCode()).isEqualTo(404);
        assertThat(foreign.getMessage()).contains("预约记录不存在");
    }

    @Test
    void detailEnforcesDoctorScopeAndAllowsAdmin() {
        Appointment appointment = pendingAppointment(1L, 7L);
        appointment.setDoctorId(2L);
        when(appointmentMapper.selectById(1L)).thenReturn(appointment);
        SysUser owner = new SysUser();
        owner.setId(7L);
        owner.setNickname("小王");
        owner.setPhone("13800000000");
        when(sysUserMapper.selectBatchIds(anyCollection())).thenReturn(List.of(owner));

        UserContext.set(doctor(2L));
        AppointmentVo own = service.detail(1L);
        assertThat(own.getUserNickname()).isEqualTo("小王");
        assertThat(own.getUserPhone()).isEqualTo("13800000000");

        UserContext.set(doctor(3L));
        BizException forbidden = biz(() -> service.detail(1L));
        assertThat(forbidden.getCode()).isEqualTo(403);
        assertThat(forbidden.getMessage()).contains("只能查看自己接诊的单子");

        UserContext.set(admin());
        assertThat(service.detail(1L).getId()).isEqualTo(1L);
    }

    @Test
    void detailRejectsMissingAppointment() {
        when(appointmentMapper.selectById(1L)).thenReturn(null);
        UserContext.set(admin());

        BizException e = biz(() -> service.detail(1L));

        assertThat(e.getCode()).isEqualTo(404);
        assertThat(e.getMessage()).contains("预约记录不存在");
    }

    @Test
    void requireMineChecksOwnershipAndExistence() {
        UserContext.set(client(7L));
        when(appointmentMapper.selectById(1L)).thenReturn(pendingAppointment(1L, 7L));
        assertThat(service.requireMine(1L).getUserId()).isEqualTo(7L);

        when(appointmentMapper.selectById(2L)).thenReturn(pendingAppointment(2L, 8L));
        assertThat(biz(() -> service.requireMine(2L)).getCode()).isEqualTo(404);

        when(appointmentMapper.selectById(3L)).thenReturn(null);
        assertThat(biz(() -> service.requireMine(3L)).getCode()).isEqualTo(404);
    }

    @Test
    void lockForWriteReturnsLockedRowOr404() {
        Appointment locked = pendingAppointment(1L, 7L);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(locked);
        assertThat(service.lockForWrite(1L)).isSameAs(locked);

        when(appointmentMapper.selectByIdForUpdate(2L)).thenReturn(null);
        assertThat(biz(() -> service.lockForWrite(2L)).getCode()).isEqualTo(404);
    }

    @Test
    @SuppressWarnings("unchecked")
    void markReviewedWritesFlag() {
        service.markReviewed(9L);

        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue())).contains(1, 9L);
    }

    // ---------------------------------------------------------------- 定时清扫

    @Test
    void unpaidOverdueIdsUsesConfiguredCutoff() {
        when(appointmentMapper.selectUnpaidOverdueIds(any())).thenReturn(List.of(1L, 2L));
        LocalDateTime before = LocalDateTime.now().minusMinutes(30);
        List<Long> ids = service.unpaidOverdueIds();
        LocalDateTime after = LocalDateTime.now().minusMinutes(30);

        assertThat(ids).containsExactly(1L, 2L);
        ArgumentCaptor<LocalDateTime> captor = ArgumentCaptor.forClass(LocalDateTime.class);
        verify(appointmentMapper).selectUnpaidOverdueIds(captor.capture());
        assertThat(captor.getValue()).isBetween(before.minusSeconds(2), after.plusSeconds(2));
    }

    @Test
    void staleVisitIdsDelegatesToMapper() {
        when(appointmentMapper.selectStaleVisitIds()).thenReturn(List.of(3L, 4L));

        assertThat(service.staleVisitIds()).containsExactly(3L, 4L);
        verify(appointmentMapper).selectStaleVisitIds();
    }

    @Test
    void expireOneRechecksStatusPaymentAndDeadlineInsideLock() {
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(null);
        assertThat(service.expireOne(1L)).isFalse();

        Appointment accepted = pendingAppointment(1L, 7L);
        accepted.setStatus(Appointment.ST_ACCEPTED);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(accepted);
        assertThat(service.expireOne(1L)).isFalse();

        Appointment paid = pendingAppointment(1L, 7L);
        paid.setPayStatus(Appointment.PAY_PAID);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(paid);
        assertThat(service.expireOne(1L)).isFalse();

        Appointment fresh = pendingAppointment(1L, 7L);
        fresh.setCreateTime(LocalDateTime.now());
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(fresh);
        assertThat(service.expireOne(1L)).isFalse();
        verify(appointmentMapper, never()).update(any(), any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void expireOneCancelsOverdueUnpaidOrder() {
        Appointment expired = pendingAppointment(1L, 7L);
        expired.setScheduleId(4L);
        expired.setCreateTime(LocalDateTime.now().minusMinutes(31));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(expired);

        assertThat(service.expireOne(1L)).isTrue();

        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue())).anyMatch(v -> v instanceof String s
                && s.contains("超过 30 分钟未支付")).contains("SYSTEM", Appointment.ST_CANCELLED);
        verify(scheduleMapper).release(4L);
    }

    @Test
    void expireOneFailsWhenCancelUpdateMisses() {
        Appointment expired = pendingAppointment(1L, 7L);
        expired.setCreateTime(LocalDateTime.now().minusMinutes(31));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(expired);
        when(appointmentMapper.update(any(), any())).thenReturn(0);

        BizException e = biz(() -> service.expireOne(1L));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("该预约已取消");
    }

    @Test
    void markMissedOneRechecksDateStatusAndPayment() {
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(null);
        assertThat(service.markMissedOne(1L)).isFalse();

        Appointment noDate = pendingAppointment(1L, 7L);
        noDate.setPayStatus(Appointment.PAY_PAID);
        noDate.setAppointmentDate(null);
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(noDate);
        assertThat(service.markMissedOne(1L)).isFalse();

        Appointment today = pendingAppointment(1L, 7L);
        today.setPayStatus(Appointment.PAY_PAID);
        today.setAppointmentDate(LocalDate.now());
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(today);
        assertThat(service.markMissedOne(1L)).isFalse();

        Appointment accepted = pendingAppointment(1L, 7L);
        accepted.setPayStatus(Appointment.PAY_PAID);
        accepted.setStatus(Appointment.ST_ACCEPTED);
        accepted.setAppointmentDate(LocalDate.now().minusDays(1));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(accepted);
        assertThat(service.markMissedOne(1L)).isFalse();

        Appointment unpaid = pendingAppointment(1L, 7L);
        unpaid.setAppointmentDate(LocalDate.now().minusDays(1));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(unpaid);
        assertThat(service.markMissedOne(1L)).isFalse();
        verify(appointmentMapper, never()).update(any(), any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void markMissedOneWritesMissedStatusOnlyWhenConditionalUpdateMatches() {
        Appointment stale = pendingAppointment(1L, 7L);
        stale.setPayStatus(Appointment.PAY_PAID);
        stale.setAppointmentDate(LocalDate.now().minusDays(1));
        when(appointmentMapper.selectByIdForUpdate(1L)).thenReturn(stale);

        assertThat(service.markMissedOne(1L)).isTrue();
        ArgumentCaptor<Wrapper<Appointment>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(appointmentMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue()))
                .contains(Appointment.ST_MISSED, Appointment.ST_PENDING, Appointment.PAY_PAID, 1L);

        when(appointmentMapper.update(any(), any())).thenReturn(0);
        assertThat(service.markMissedOne(1L)).isFalse();
    }

    // ---------------------------------------------------------------- fixtures

    private static Pet pet(long id, long userId) {
        Pet pet = new Pet();
        pet.setId(id);
        pet.setUserId(userId);
        pet.setName("团子");
        return pet;
    }

    private static Doctor doctor(long id, long departmentId, int status, BigDecimal fee) {
        Doctor doctor = new Doctor();
        doctor.setId(id);
        doctor.setDepartmentId(departmentId);
        doctor.setStatus(status);
        doctor.setConsultationFee(fee);
        doctor.setName("陈明远");
        return doctor;
    }

    private static DoctorSchedule schedule(long id, long doctorId, LocalDate workDate) {
        DoctorSchedule schedule = new DoctorSchedule();
        schedule.setId(id);
        schedule.setDoctorId(doctorId);
        schedule.setWorkDate(workDate);
        schedule.setPeriod(1);
        schedule.setStartTime(LocalTime.of(9, 0));
        schedule.setEndTime(LocalTime.of(11, 0));
        schedule.setTotalNum(10);
        schedule.setRemainNum(10);
        schedule.setStatus(1);
        return schedule;
    }

    private static Appointment pendingAppointment(long id, long userId) {
        Appointment appointment = new Appointment();
        appointment.setId(id);
        appointment.setUserId(userId);
        appointment.setPetId(1L);
        appointment.setDoctorId(2L);
        appointment.setDepartmentId(3L);
        appointment.setScheduleId(4L);
        appointment.setAppointmentDate(LocalDate.now().plusDays(1));
        appointment.setPeriod(1);
        appointment.setStartTime(LocalTime.of(9, 0));
        appointment.setEndTime(LocalTime.of(11, 0));
        appointment.setStatus(Appointment.ST_PENDING);
        appointment.setPayStatus(Appointment.PAY_NONE);
        appointment.setAmount(new BigDecimal("50"));
        return appointment;
    }

    private static AppointmentForm form(Long petId, Long doctorId, Long scheduleId, String symptom) {
        AppointmentForm form = new AppointmentForm();
        form.setPetId(petId);
        form.setDoctorId(doctorId);
        form.setScheduleId(scheduleId);
        form.setSymptom(symptom);
        form.setImages("   ");
        return form;
    }

    private static LoginUser client(long id) {
        LoginUser user = new LoginUser();
        user.setId(id);
        user.setTyp(LoginUser.TYP_CLIENT);
        user.setRole(LoginUser.ROLE_USER);
        user.setUsername("client" + id);
        return user;
    }

    private static LoginUser doctor(long doctorId) {
        LoginUser user = new LoginUser();
        user.setId(900L);
        user.setTyp(LoginUser.TYP_ADMIN);
        user.setRole(LoginUser.ROLE_DOCTOR);
        user.setDoctorId(doctorId);
        user.setUsername("doctor" + doctorId);
        return user;
    }

    private static LoginUser admin() {
        LoginUser user = new LoginUser();
        user.setId(901L);
        user.setTyp(LoginUser.TYP_ADMIN);
        user.setRole(LoginUser.ROLE_ADMIN);
        user.setUsername("admin");
        return user;
    }

    private static BizException biz(Runnable action) {
        Throwable thrown = catchThrowable(action::run);
        assertThat(thrown).as("expected BizException").isInstanceOf(BizException.class);
        return (BizException) thrown;
    }

    private static List<Object> values(Wrapper<?> wrapper) {
        // eq 的参数是延迟写入 paramNameValuePairs 的 ISqlSegment，先求值 SQL 再读字典。
        ((AbstractWrapper<?, ?, ?>) wrapper).getSqlSegment();
        return new java.util.ArrayList<>(((AbstractWrapper<?, ?, ?>) wrapper).getParamNameValuePairs().values());
    }

    private static String sql(Wrapper<?> wrapper) {
        return ((AbstractWrapper<?, ?, ?>) wrapper).getSqlSegment();
    }
}