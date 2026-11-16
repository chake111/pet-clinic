package com.petclinic.service;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.AbstractWrapper;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
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
import org.apache.ibatis.builder.MapperBuilderAssistant;
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
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * DoctorScheduleService 的号源保护、归属冻结、批量排班与 VO 组装的单元覆盖。
 *
 * <p>append-only 协同：创建/更新会真实走到 mapper.insert/updateById（mock 返回成功），
 * 断言落在返回实体或 updateById 捕获的参数上；批量落库 saveBatch 用 spy 拦截，
 * 避免依赖 MyBatis-Plus 的 SqlSession 批量执行。
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class DoctorScheduleServiceCoverageTest {

    @Mock
    private DoctorScheduleMapper scheduleMapper;
    @Mock
    private DoctorMapper doctorMapper;
    @Mock
    private AppointmentMapper appointmentMapper;
    @Mock
    private DepartmentMapper departmentMapper;

    private DoctorScheduleService service;

    @BeforeAll
    static void initTableInfo() {
        MybatisConfiguration configuration = new MybatisConfiguration();
        for (Class<?> type : List.of(DoctorSchedule.class, Appointment.class, Doctor.class, Department.class)) {
            TableInfoHelper.initTableInfo(new MapperBuilderAssistant(configuration, "test"), type);
        }
    }

    @BeforeEach
    void setUp() {
        service = spy(new DoctorScheduleService(doctorMapper, appointmentMapper, departmentMapper));
        ReflectionTestUtils.setField(service, "baseMapper", scheduleMapper);

        when(scheduleMapper.insert(any(DoctorSchedule.class))).thenReturn(1);
        when(scheduleMapper.update(any(), any())).thenReturn(1);
        when(scheduleMapper.deleteById(any(java.io.Serializable.class))).thenReturn(1);
        when(scheduleMapper.selectList(any())).thenReturn(List.of());
        doAnswer(invocation -> {
            Page<DoctorSchedule> page = invocation.getArgument(0);
            page.setRecords(List.of());
            page.setTotal(0);
            return page;
        }).when(scheduleMapper).selectPage(any(), any());
        when(appointmentMapper.selectCount(any())).thenReturn(0L);
        when(appointmentMapper.selectMaps(any())).thenReturn(List.of());
        when(doctorMapper.selectBatchIds(anyCollection())).thenReturn(List.of());
        when(departmentMapper.selectBatchIds(anyCollection())).thenReturn(List.of());
    }

    // ---------------------------------------------------------------- 用户端选号

    @Test
    @SuppressWarnings("unchecked")
    void listBookableUsesDefaultsAndClampsDays() {
        LocalDate today = LocalDate.now();
        Doctor doctor = doctor(10L, 5L, 1);
        Department department = department(5L, "内科");
        DoctorSchedule slot = schedule(1L, 10L, today.plusDays(2));
        when(scheduleMapper.selectList(any())).thenReturn(List.of(slot));
        when(doctorMapper.selectById(10L)).thenReturn(doctor);
        when(departmentMapper.selectBatchIds(anyCollection())).thenReturn(List.of(department));

        List<ScheduleVo> defaulted = service.listBookable(10L, null, null);
        assertThat(defaulted).singleElement().satisfies(vo -> {
            assertThat(vo.getId()).isEqualTo(1L);
            assertThat(vo.getDoctorName()).isEqualTo("陈明远");
            assertThat(vo.getDoctorTitle()).isEqualTo("主任医师");
            assertThat(vo.getDepartmentId()).isEqualTo(5L);
            assertThat(vo.getDepartmentName()).isEqualTo("内科");
            assertThat(vo.getConsultationFee()).isEqualByComparingTo("50");
            assertThat(vo.getDoctorAvailable()).isTrue();
            assertThat(vo.getRefNum()).isNull();
        });

        service.listBookable(10L, today, 0);
        service.listBookable(10L, today, 100);

        ArgumentCaptor<Wrapper<DoctorSchedule>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(scheduleMapper, times(3)).selectList(captor.capture());
        assertThat(values(captor.getAllValues().get(0)))
                .contains(10L, 1);
        assertThat(values(captor.getAllValues().get(1)))
                .contains(10L, 1, today, today);
        assertThat(values(captor.getAllValues().get(2)))
                .contains(10L, 1, today, today.plusDays(29));
    }

    @Test
    void listBookableHandlesMissingDoctorAndMissingDepartment() {
        LocalDate date = LocalDate.now().plusDays(1);
        DoctorSchedule slot = schedule(1L, 10L, date);
        when(scheduleMapper.selectList(any())).thenReturn(List.of(slot));
        when(doctorMapper.selectById(10L)).thenReturn(null);

        ScheduleVo missingDoctor = service.listBookable(10L, null, null).get(0);
        assertThat(missingDoctor.getDoctorAvailable()).isFalse();
        assertThat(missingDoctor.getDoctorName()).isNull();
        assertThat(missingDoctor.getDepartmentName()).isNull();

        Doctor stopped = doctor(10L, 5L, 0);
        when(doctorMapper.selectById(10L)).thenReturn(stopped);
        when(departmentMapper.selectBatchIds(anyCollection())).thenReturn(List.of());

        ScheduleVo stoppedVo = service.listBookable(10L, null, null).get(0);
        assertThat(stoppedVo.getDoctorAvailable()).isFalse();
        assertThat(stoppedVo.getDoctorName()).isEqualTo("陈明远");
        assertThat(stoppedVo.getDepartmentName()).isNull();
    }

    // ---------------------------------------------------------------- 后台分页

    @Test
    @SuppressWarnings("unchecked")
    void pageAdminBackfillsRefCountsAndFilters() {
        LocalDate start = LocalDate.now();
        LocalDate end = LocalDate.now().plusDays(7);
        DoctorSchedule first = schedule(1L, 10L, start);
        DoctorSchedule second = schedule(2L, 10L, start.plusDays(1));
        DoctorSchedule withoutId = schedule(3L, 10L, start.plusDays(2));
        withoutId.setId(null);
        doAnswer(invocation -> {
            Page<DoctorSchedule> page = invocation.getArgument(0);
            page.setRecords(List.of(first, second, withoutId));
            page.setTotal(3);
            return page;
        }).when(scheduleMapper).selectPage(any(), any());
        Doctor doctor = doctor(10L, 5L, 1);
        when(doctorMapper.selectBatchIds(anyCollection())).thenReturn(List.of(doctor));
        Department department = department(5L, "内科");
        when(departmentMapper.selectBatchIds(anyCollection())).thenReturn(List.of(department));

        Map<String, Object> ref = new HashMap<>();
        ref.put("scheduleId", 1L);
        ref.put("num", 2L);
        Map<String, Object> nullScheduleId = new HashMap<>();
        nullScheduleId.put("scheduleId", null);
        nullScheduleId.put("num", 9L);
        when(appointmentMapper.selectMaps(any())).thenReturn(List.of(ref, nullScheduleId));

        PageQuery query = new PageQuery();
        query.setPageNum(2);
        query.setPageSize(50);
        PageResult<ScheduleVo> result = service.pageAdmin(10L, start, end, 1, query);

        assertThat(result.getTotal()).isEqualTo(3);
        assertThat(result.getCurrent()).isEqualTo(2);
        assertThat(result.getSize()).isEqualTo(50);
        assertThat(result.getRecords()).hasSize(3);
        assertThat(result.getRecords().get(0).getRefNum()).isEqualTo(2L);
        assertThat(result.getRecords().get(1).getRefNum()).isZero();
        assertThat(result.getRecords().get(2).getRefNum()).isZero();
        assertThat(result.getRecords().get(0).getDepartmentName()).isEqualTo("内科");

        ArgumentCaptor<Wrapper<DoctorSchedule>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(scheduleMapper).selectPage(any(), captor.capture());
        assertThat(values(captor.getValue())).contains(10L, start, end, 1);
    }

    @Test
    void pageAdminWithoutRowsSkipsReferenceQueryAndFilters() {
        PageQuery query = new PageQuery();
        PageResult<ScheduleVo> result = service.pageAdmin(null, null, null, null, query);

        assertThat(result.getRecords()).isEmpty();
        assertThat(result.getTotal()).isZero();
        verify(appointmentMapper, never()).selectMaps(any());
        verify(doctorMapper, never()).selectBatchIds(anyCollection());

        ArgumentCaptor<Wrapper<DoctorSchedule>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(scheduleMapper).selectPage(any(), captor.capture());
        assertThat(values(captor.getValue())).isEmpty();
    }

    // ---------------------------------------------------------------- 新建

    @Test
    void createRejectsUnknownOrStoppedDoctor() {
        when(doctorMapper.selectById(10L)).thenReturn(null);
        BizException missing = biz(() -> service.create(form(10L, LocalDate.now().plusDays(1), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10, null)));
        assertThat(missing.getCode()).isEqualTo(404);
        assertThat(missing.getMessage()).contains("医生不存在");

        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 0));
        BizException stopped = biz(() -> service.create(form(10L, LocalDate.now().plusDays(1), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10, null)));
        assertThat(stopped.getCode()).isEqualTo(400);
        assertThat(stopped.getMessage()).contains("停诊状态");
        verify(scheduleMapper, never()).insert(any(DoctorSchedule.class));
    }

    @Test
    void createValidatesDateAndTimeOrder() {
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));

        assertThat(biz(() -> service.create(form(10L, null, 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10, null))).getMessage())
                .contains("请选择排班日期");
        assertThat(biz(() -> service.create(form(10L, LocalDate.now().minusDays(1), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10, null))).getMessage())
                .contains("不能给过去的日期排班");
        assertThat(biz(() -> service.create(form(10L, LocalDate.now().plusDays(1), 1,
                LocalTime.of(10, 0), LocalTime.of(10, 0), 10, null))).getMessage())
                .contains("结束时间必须晚于开始时间");
        assertThat(biz(() -> service.create(form(10L, LocalDate.now().plusDays(1), 1,
                null, LocalTime.of(11, 0), 10, null))).getMessage())
                .contains("结束时间必须晚于开始时间");
        assertThat(biz(() -> service.create(form(10L, LocalDate.now().plusDays(1), 1,
                LocalTime.of(9, 0), null, 10, null))).getMessage())
                .contains("结束时间必须晚于开始时间");
        verify(scheduleMapper, never()).insert(any(DoctorSchedule.class));
    }

    @Test
    void createValidatesPeriodAndPeriodWindowAndDuplicate() {
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        LocalDate date = LocalDate.now().plusDays(1);

        assertThat(biz(() -> service.create(form(10L, date, 0,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10, null))).getMessage())
                .contains("时段只能是");
        assertThat(biz(() -> service.create(form(10L, date, null,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10, null))).getMessage())
                .contains("时段只能是");

        assertThat(biz(() -> service.create(form(10L, date, 1,
                LocalTime.of(7, 0), LocalTime.of(9, 0), 10, null))).getMessage())
                .contains("上午排班时间须在");
        assertThat(biz(() -> service.create(form(10L, date, 2,
                LocalTime.of(12, 0), LocalTime.of(14, 0), 10, null))).getMessage())
                .contains("下午排班时间须在");
        assertThat(biz(() -> service.create(form(10L, date, 3,
                LocalTime.of(17, 0), LocalTime.of(19, 0), 10, null))).getMessage())
                .contains("夜间排班时间须在");

        when(scheduleMapper.exists(any())).thenReturn(true);
        BizException duplicate = biz(() -> service.create(form(10L, date, 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10, null)));
        assertThat(duplicate.getMessage()).contains("已经排过班");
        verify(scheduleMapper, never()).insert(any(DoctorSchedule.class));
    }

    @Test
    void createAcceptsAllPeriodsAndDefaultsStatus() {
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        LocalDate date = LocalDate.now().plusDays(1);

        DoctorSchedule morning = service.create(form(10L, date, 1,
                LocalTime.of(8, 0), LocalTime.of(12, 0), 10, null));
        DoctorSchedule afternoon = service.create(form(10L, date.plusDays(1), 2,
                LocalTime.of(13, 0), LocalTime.of(18, 0), 8, null));
        DoctorSchedule night = service.create(form(10L, date.plusDays(2), 3,
                LocalTime.of(18, 0), LocalTime.of(22, 0), 6, 0));

        assertThat(morning.getStatus()).isEqualTo(1);
        assertThat(morning.getRemainNum()).isEqualTo(10);
        assertThat(afternoon.getStatus()).isEqualTo(1);
        assertThat(afternoon.getRemainNum()).isEqualTo(8);
        assertThat(night.getStatus()).isZero();
        assertThat(night.getRemainNum()).isEqualTo(6);
        assertThat(morning.getDoctorId()).isEqualTo(10L);
        assertThat(morning.getWorkDate()).isEqualTo(date);
        assertThat(morning.getStartTime()).isEqualTo(LocalTime.of(8, 0));
        assertThat(morning.getEndTime()).isEqualTo(LocalTime.of(12, 0));

        ArgumentCaptor<DoctorSchedule> captor = ArgumentCaptor.forClass(DoctorSchedule.class);
        verify(scheduleMapper, times(3)).insert(captor.capture());
        assertThat(captor.getAllValues()).extracting(DoctorSchedule::getPeriod)
                .containsExactly(1, 2, 3);
    }

    // ---------------------------------------------------------------- 修改

    @Test
    void updateRejectsMissingSchedule() {
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(null);

        BizException e = biz(() -> service.update(1L, edit(10L, LocalDate.now().plusDays(1), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10)));

        assertThat(e.getCode()).isEqualTo(404);
        assertThat(e.getMessage()).contains("排班不存在");
    }

    @Test
    void updateValidatesChangedDateAndSlotFields() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);

        BizException emptyDate = biz(() -> service.update(1L, edit(10L, null, 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10)));
        assertThat(emptyDate.getMessage()).contains("请选择排班日期");

        BizException pastDate = biz(() -> service.update(1L, edit(10L, LocalDate.now().minusDays(1), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10)));
        assertThat(pastDate.getMessage()).contains("不能给过去的日期排班");

        BizException badTime = biz(() -> service.update(1L, edit(10L, current.getWorkDate(), 1,
                LocalTime.of(11, 0), LocalTime.of(11, 0), 10)));
        assertThat(badTime.getMessage()).contains("结束时间必须晚于开始时间");

        BizException badPeriod = biz(() -> service.update(1L, edit(10L, current.getWorkDate(), 4,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10)));
        assertThat(badPeriod.getMessage()).contains("时段只能是");
        verify(scheduleMapper, never()).updateById(any(DoctorSchedule.class));
    }

    @Test
    void updateAllowsCapacityChangeOnHistoricalSchedule() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().minusDays(1));
        current.setRemainNum(8);
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        Doctor stopped = doctor(10L, 5L, 0);
        when(doctorMapper.selectById(10L)).thenReturn(stopped);
        when(appointmentMapper.selectCount(any())).thenReturn(0L, 2L);

        service.update(1L, edit(10L, current.getWorkDate(), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 5));

        ArgumentCaptor<DoctorSchedule> captor = ArgumentCaptor.forClass(DoctorSchedule.class);
        verify(scheduleMapper).updateById(captor.capture());
        DoctorSchedule written = captor.getValue();
        assertThat(written.getId()).isEqualTo(1L);
        assertThat(written.getTotalNum()).isEqualTo(5);
        assertThat(written.getRemainNum()).isEqualTo(3);
        assertThat(written.getStatus()).as("编辑接口不写 status").isNull();
    }

    @Test
    void updateRejectsDuplicateCrossDoctorSlot() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        when(scheduleMapper.exists(any())).thenReturn(true);

        BizException e = biz(() -> service.update(1L, edit(11L, current.getWorkDate(), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10)));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("已经排过班");
        verify(doctorMapper, never()).selectById(any());
        verify(scheduleMapper, never()).updateById(any(DoctorSchedule.class));
    }

    @Test
    void updateFreezesAttributionWhenReferenced() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        when(appointmentMapper.selectCount(any())).thenReturn(3L);

        BizException e = biz(() -> service.update(1L, edit(11L, current.getWorkDate(), 2,
                LocalTime.of(13, 0), LocalTime.of(15, 0), 10)));

        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("3 条预约记录").contains("不能改医生、日期或时段");
        verify(doctorMapper, never()).selectById(any());
        verify(scheduleMapper, never()).updateById(any(DoctorSchedule.class));
    }

    @Test
    void updateAllowsCapacityChangeWithReferencesButRejectsBelowBooked() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        current.setRemainNum(7);
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        when(appointmentMapper.selectCount(any())).thenReturn(3L, 1L);

        service.update(1L, edit(10L, current.getWorkDate(), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10));
        ArgumentCaptor<DoctorSchedule> captor = ArgumentCaptor.forClass(DoctorSchedule.class);
        verify(scheduleMapper).updateById(captor.capture());
        assertThat(captor.getValue().getRemainNum()).isEqualTo(9);
        assertThat(captor.getValue().getTotalNum()).isEqualTo(10);

        when(appointmentMapper.selectCount(any())).thenReturn(0L, 5L);
        BizException e = biz(() -> service.update(1L, edit(10L, current.getWorkDate(), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 4)));
        assertThat(e.getCode()).isEqualTo(400);
        assertThat(e.getMessage()).contains("5 个有效预约");
    }

    @Test
    void updateRequiresSchedulableDoctorOnlyWhenAttributionMoves() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        when(appointmentMapper.selectCount(any())).thenReturn(0L, 0L);
        when(doctorMapper.selectById(11L)).thenReturn(doctor(11L, 5L, 0));

        BizException stopped = biz(() -> service.update(1L, edit(11L, current.getWorkDate(), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10)));
        assertThat(stopped.getCode()).isEqualTo(400);
        assertThat(stopped.getMessage()).contains("停诊状态");

        when(doctorMapper.selectById(10L)).thenReturn(null);
        BizException missing = biz(() -> service.update(1L, edit(10L, current.getWorkDate(), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10)));
        assertThat(missing.getCode()).isEqualTo(404);
        assertThat(missing.getMessage()).contains("医生不存在");
    }

    @Test
    void updateAllowsChangingPeriodOnSameDay() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        when(appointmentMapper.selectCount(any())).thenReturn(0L, 0L);

        service.update(1L, edit(10L, current.getWorkDate(), 2,
                LocalTime.of(13, 0), LocalTime.of(15, 0), 10));

        ArgumentCaptor<DoctorSchedule> captor = ArgumentCaptor.forClass(DoctorSchedule.class);
        verify(scheduleMapper).updateById(captor.capture());
        assertThat(captor.getValue().getPeriod()).isEqualTo(2);
        assertThat(captor.getValue().getStartTime()).isEqualTo(LocalTime.of(13, 0));
        assertThat(captor.getValue().getEndTime()).isEqualTo(LocalTime.of(15, 0));
        assertThat(captor.getValue().getRemainNum()).isEqualTo(10);
    }

    @Test
    void updateAllowsChangingOnlyEndTimeAfterWindowValidation() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        when(appointmentMapper.selectCount(any())).thenReturn(0L, 0L);

        service.update(1L, edit(10L, current.getWorkDate(), 1,
                LocalTime.of(9, 0), LocalTime.of(10, 0), 10));

        ArgumentCaptor<DoctorSchedule> captor = ArgumentCaptor.forClass(DoctorSchedule.class);
        verify(scheduleMapper).updateById(captor.capture());
        assertThat(captor.getValue().getStartTime()).isEqualTo(LocalTime.of(9, 0));
        assertThat(captor.getValue().getEndTime()).isEqualTo(LocalTime.of(10, 0));
        assertThat(captor.getValue().getRemainNum()).isEqualTo(10);
        assertThat(captor.getValue().getStatus()).isNull();
    }

    @Test
    void updateWritesNewAttributionAndValidatesNewWindow() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        when(doctorMapper.selectById(11L)).thenReturn(doctor(11L, 5L, 1));
        when(appointmentMapper.selectCount(any())).thenReturn(0L, 0L);
        LocalDate newDate = LocalDate.now().plusDays(2);

        service.update(1L, edit(11L, newDate, 2,
                LocalTime.of(13, 0), LocalTime.of(15, 0), 12));

        ArgumentCaptor<DoctorSchedule> captor = ArgumentCaptor.forClass(DoctorSchedule.class);
        verify(scheduleMapper).updateById(captor.capture());
        DoctorSchedule written = captor.getValue();
        assertThat(written.getDoctorId()).isEqualTo(11L);
        assertThat(written.getWorkDate()).isEqualTo(newDate);
        assertThat(written.getPeriod()).isEqualTo(2);
        assertThat(written.getStartTime()).isEqualTo(LocalTime.of(13, 0));
        assertThat(written.getEndTime()).isEqualTo(LocalTime.of(15, 0));
        assertThat(written.getTotalNum()).isEqualTo(12);
        assertThat(written.getRemainNum()).isEqualTo(12);
        assertThat(written.getStatus()).isNull();

        BizException badWindow = biz(() -> service.update(1L, edit(11L, newDate, 2,
                LocalTime.of(12, 0), LocalTime.of(14, 0), 12)));
        assertThat(badWindow.getMessage()).contains("下午排班时间须在");
    }

    // ---------------------------------------------------------------- 批量排班

    @Test
    void batchCreateRejectsUnschedulableDoctorAndBadRange() {
        when(doctorMapper.selectById(10L)).thenReturn(null);
        assertThat(biz(() -> service.batchCreate(batch(10L, LocalDate.now(), LocalDate.now().plusDays(1),
                List.of(1), List.of(template(1, 9, 11, 10)), null))).getCode()).isEqualTo(404);

        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 0));
        assertThat(biz(() -> service.batchCreate(batch(10L, LocalDate.now(), LocalDate.now().plusDays(1),
                List.of(1), List.of(template(1, 9, 11, 10)), null))).getMessage()).contains("停诊状态");

        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        assertThat(biz(() -> service.batchCreate(batch(10L, LocalDate.now(), LocalDate.now().minusDays(1),
                List.of(1), List.of(template(1, 9, 11, 10)), null))).getMessage()).contains("开始日期不能晚于结束日期");
        assertThat(biz(() -> service.batchCreate(batch(10L, LocalDate.now(), LocalDate.now().plusDays(90),
                List.of(1), List.of(template(1, 9, 11, 10)), null))).getMessage()).contains("最多批量排 90 天");
        verify(scheduleMapper, never()).insert(any(DoctorSchedule.class));
    }

    @Test
    void batchCreateRejectsDuplicateAndInvalidTemplates() {
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        LocalDate date = LocalDate.now().plusDays(1);

        BizException duplicate = biz(() -> service.batchCreate(batch(10L, date, date,
                List.of(date.getDayOfWeek().getValue()),
                List.of(template(1, 9, 11, 10), template(1, 9, 11, 10)), null)));
        assertThat(duplicate.getMessage()).contains("每个时段只能配置一次");

        BizException badPeriod = biz(() -> service.batchCreate(batch(10L, date, date,
                List.of(date.getDayOfWeek().getValue()),
                List.of(template(4, 9, 11, 10)), null)));
        assertThat(badPeriod.getMessage()).contains("时段只能是");

        BizException badWindow = biz(() -> service.batchCreate(batch(10L, date, date,
                List.of(date.getDayOfWeek().getValue()),
                List.of(template(1, 7, 9, 10)), null)));
        assertThat(badWindow.getMessage()).contains("上午排班时间须在");
        verify(scheduleMapper, never()).insert(any(DoctorSchedule.class));
    }

    @Test
    void batchCreateSkipsPastAndUnmatchedWeekdays() {
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));

        DoctorScheduleService.BatchSummary past = service.batchCreate(batch(10L,
                LocalDate.now().minusDays(5), LocalDate.now().minusDays(1),
                List.of(1, 2, 3, 4, 5, 6, 7),
                List.of(template(1, 9, 11, 10)), null));
        assertThat(past.created()).isZero();
        assertThat(past.skipped()).isZero();

        LocalDate future = LocalDate.now().plusDays(1);
        int otherWeekday = future.getDayOfWeek().getValue() % 7 + 1;
        DoctorScheduleService.BatchSummary unmatched = service.batchCreate(batch(10L, future, future,
                List.of(otherWeekday), List.of(template(1, 9, 11, 10)), null));
        assertThat(unmatched.created()).isZero();
        assertThat(unmatched.skipped()).isZero();
        verify(scheduleMapper, never()).insert(any(DoctorSchedule.class));
    }

    @Test
    void batchCreateCountsExistingSlotsAsSkipped() {
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        LocalDate date = LocalDate.now().plusDays(1);
        when(scheduleMapper.exists(any())).thenReturn(true);

        DoctorScheduleService.BatchSummary summary = service.batchCreate(batch(10L, date, date,
                List.of(date.getDayOfWeek().getValue()),
                List.of(template(1, 9, 11, 10)), null));

        assertThat(summary.created()).isZero();
        assertThat(summary.skipped()).isEqualTo(1);
        verify(scheduleMapper, never()).insert(any(DoctorSchedule.class));
    }

    @Test
    @SuppressWarnings("unchecked")
    void batchCreateSavesNewSlotsAndCountsSkipped() {
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        LocalDate date = LocalDate.now().plusDays(1);
        when(scheduleMapper.exists(any())).thenReturn(false, true);
        List<DoctorSchedule> saved = new ArrayList<>();
        doAnswer(invocation -> {
            saved.addAll((Collection<DoctorSchedule>) invocation.getArgument(0));
            return true;
        }).when(service).saveBatch(anyCollection(), anyInt());

        DoctorScheduleService.BatchSummary summary = service.batchCreate(batch(10L, date, date,
                List.of(date.getDayOfWeek().getValue()),
                List.of(template(1, 9, 11, 10), template(2, 13, 15, 8)), null));

        assertThat(summary.created()).isEqualTo(1);
        assertThat(summary.skipped()).isEqualTo(1);
        assertThat(saved).singleElement().satisfies(slot -> {
            assertThat(slot.getDoctorId()).isEqualTo(10L);
            assertThat(slot.getWorkDate()).isEqualTo(date);
            assertThat(slot.getPeriod()).isEqualTo(1);
            assertThat(slot.getStartTime()).isEqualTo(LocalTime.of(9, 0));
            assertThat(slot.getEndTime()).isEqualTo(LocalTime.of(11, 0));
            assertThat(slot.getTotalNum()).isEqualTo(10);
            assertThat(slot.getRemainNum()).isEqualTo(10);
            assertThat(slot.getStatus()).isEqualTo(1);
        });
    }

    @Test
    @SuppressWarnings("unchecked")
    void batchCreateAppliesOverrideTotalNumber() {
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        LocalDate date = LocalDate.now().plusDays(1);
        List<DoctorSchedule> saved = new ArrayList<>();
        doAnswer(invocation -> {
            saved.addAll((Collection<DoctorSchedule>) invocation.getArgument(0));
            return true;
        }).when(service).saveBatch(anyCollection(), anyInt());

        DoctorScheduleService.BatchSummary summary = service.batchCreate(batch(10L, date, date,
                List.of(date.getDayOfWeek().getValue()),
                List.of(template(1, 9, 11, 10)), 20));

        assertThat(summary.created()).isEqualTo(1);
        assertThat(saved).singleElement().satisfies(slot -> {
            assertThat(slot.getTotalNum()).isEqualTo(20);
            assertThat(slot.getRemainNum()).isEqualTo(20);
        });
    }

    // ---------------------------------------------------------------- 删除 / 停诊 / 恢复

    @Test
    void removeRejectsMissingOrReferencedSchedule() {
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(null);
        assertThat(biz(() -> service.remove(1L)).getCode()).isEqualTo(404);

        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(schedule(1L, 10L, LocalDate.now().plusDays(1)));
        when(appointmentMapper.selectCount(any())).thenReturn(2L);
        BizException referenced = biz(() -> service.remove(1L));
        assertThat(referenced.getCode()).isEqualTo(400);
        assertThat(referenced.getMessage()).contains("2 条预约记录").contains("不能删除");
        verify(scheduleMapper, never()).deleteById(any(java.io.Serializable.class));
    }

    @Test
    void removeDeletesUnreferencedSchedule() {
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(schedule(1L, 10L, LocalDate.now().plusDays(1)));

        service.remove(1L);

        verify(scheduleMapper).deleteById(1L);
    }

    @Test
    void stopClinicRequiresExistingRowAndAffectedUpdate() {
        when(scheduleMapper.selectById(1L)).thenReturn(null);
        assertThat(biz(() -> service.stopClinic(1L)).getCode()).isEqualTo(404);

        when(scheduleMapper.selectById(1L)).thenReturn(schedule(1L, 10L, LocalDate.now().plusDays(1)));
        when(scheduleMapper.update(any(), any())).thenReturn(0);
        BizException missed = biz(() -> service.stopClinic(1L));
        assertThat(missed.getCode()).isEqualTo(404);
        assertThat(missed.getMessage()).contains("排班不存在");
    }

    @Test
    @SuppressWarnings("unchecked")
    void stopClinicWritesOffStatus() {
        when(scheduleMapper.selectById(1L)).thenReturn(schedule(1L, 10L, LocalDate.now().plusDays(1)));

        service.stopClinic(1L);

        ArgumentCaptor<Wrapper<DoctorSchedule>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(scheduleMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue())).contains(0, 1L);
    }

    @Test
    void resumeClinicChecksDoctorAndAffectedRows() {
        when(scheduleMapper.selectById(1L)).thenReturn(null);
        assertThat(biz(() -> service.resumeClinic(1L)).getCode()).isEqualTo(404);

        DoctorSchedule schedule = schedule(1L, 10L, LocalDate.now().plusDays(1));
        schedule.setStatus(0);
        when(scheduleMapper.selectById(1L)).thenReturn(schedule);
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 0));
        BizException stopped = biz(() -> service.resumeClinic(1L));
        assertThat(stopped.getCode()).isEqualTo(400);
        assertThat(stopped.getMessage()).contains("停诊状态");

        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));
        when(scheduleMapper.update(any(), any())).thenReturn(0);
        BizException missed = biz(() -> service.resumeClinic(1L));
        assertThat(missed.getCode()).isEqualTo(404);
        assertThat(missed.getMessage()).contains("排班不存在");
    }

    @Test
    @SuppressWarnings("unchecked")
    void resumeClinicWritesOnStatus() {
        DoctorSchedule schedule = schedule(1L, 10L, LocalDate.now().plusDays(1));
        schedule.setStatus(0);
        when(scheduleMapper.selectById(1L)).thenReturn(schedule);
        when(doctorMapper.selectById(10L)).thenReturn(doctor(10L, 5L, 1));

        service.resumeClinic(1L);

        ArgumentCaptor<Wrapper<DoctorSchedule>> captor = ArgumentCaptor.forClass(Wrapper.class);
        verify(scheduleMapper).update(isNull(), captor.capture());
        assertThat(values(captor.getValue())).contains(1, 1L);
    }

    @Test
    void requireReturnsRowOrThrows404() {
        DoctorSchedule schedule = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectById(1L)).thenReturn(schedule);
        assertThat(service.require(1L)).isSameAs(schedule);

        when(scheduleMapper.selectById(2L)).thenReturn(null);
        BizException e = biz(() -> service.require(2L));
        assertThat(e.getCode()).isEqualTo(404);
        assertThat(e.getMessage()).contains("排班不存在");
    }

    @Test
    void requireDoctorRejectsMissingDoctorOnCapacityChange() {
        DoctorSchedule current = schedule(1L, 10L, LocalDate.now().plusDays(1));
        when(scheduleMapper.selectByIdForUpdate(1L)).thenReturn(current);
        when(doctorMapper.selectById(10L)).thenReturn(null);

        BizException e = biz(() -> service.update(1L, edit(10L, current.getWorkDate(), 1,
                LocalTime.of(9, 0), LocalTime.of(11, 0), 10)));

        assertThat(e.getCode()).isEqualTo(404);
        assertThat(e.getMessage()).contains("医生不存在");
        verify(scheduleMapper, never()).updateById(any(DoctorSchedule.class));
    }

    // ---------------------------------------------------------------- fixtures

    private static Doctor doctor(long id, long departmentId, int status) {
        Doctor doctor = new Doctor();
        doctor.setId(id);
        doctor.setDepartmentId(departmentId);
        doctor.setStatus(status);
        doctor.setName("陈明远");
        doctor.setTitle("主任医师");
        doctor.setAvatar("doctor.png");
        doctor.setConsultationFee(new BigDecimal("50"));
        return doctor;
    }

    private static Department department(long id, String name) {
        Department department = new Department();
        department.setId(id);
        department.setName(name);
        return department;
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

    private static ScheduleForm form(Long doctorId, LocalDate date, Integer period,
                                     LocalTime start, LocalTime end, Integer total, Integer status) {
        ScheduleForm form = new ScheduleForm();
        form.setDoctorId(doctorId);
        form.setWorkDate(date);
        form.setPeriod(period);
        form.setStartTime(start);
        form.setEndTime(end);
        form.setTotalNum(total);
        form.setStatus(status);
        return form;
    }

    private static ScheduleEditForm edit(Long doctorId, LocalDate date, Integer period,
                                         LocalTime start, LocalTime end, Integer total) {
        ScheduleEditForm form = new ScheduleEditForm();
        form.setDoctorId(doctorId);
        form.setWorkDate(date);
        form.setPeriod(period);
        form.setStartTime(start);
        form.setEndTime(end);
        form.setTotalNum(total);
        return form;
    }

    private static ScheduleBatchForm batch(Long doctorId, LocalDate start, LocalDate end,
                                           List<Integer> weekDays,
                                           List<ScheduleBatchForm.PeriodTemplate> periods,
                                           Integer overrideTotalNum) {
        ScheduleBatchForm form = new ScheduleBatchForm();
        form.setDoctorId(doctorId);
        form.setStartDate(start);
        form.setEndDate(end);
        form.setWeekDays(weekDays);
        form.setPeriods(periods);
        form.setOverrideTotalNum(overrideTotalNum);
        return form;
    }

    private static ScheduleBatchForm.PeriodTemplate template(Integer period,
                                                             int startHour, int endHour, int total) {
        ScheduleBatchForm.PeriodTemplate template = new ScheduleBatchForm.PeriodTemplate();
        template.setPeriod(period);
        template.setStartTime(LocalTime.of(startHour, 0));
        template.setEndTime(LocalTime.of(endHour, 0));
        template.setTotalNum(total);
        return template;
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
}