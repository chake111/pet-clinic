package com.yuzhua.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.baomidou.mybatisplus.spring.service.impl.ServiceImpl;
import com.yuzhua.common.BatchLookup;
import com.yuzhua.common.BizException;
import com.yuzhua.common.PageResult;
import com.yuzhua.dto.PetForm;
import com.yuzhua.dto.PetQuery;
import com.yuzhua.entity.Pet;
import com.yuzhua.entity.SysUser;
import com.yuzhua.mapper.PetMapper;
import com.yuzhua.mapper.SysUserMapper;
import com.yuzhua.security.UserContext;
import com.yuzhua.vo.PetVo;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;

/**
 * 宠物档案。所有按 id 的读写都要过 requireOwned，
 * 否则改一下 URL 里的 id 就能看别人的猫。
 */
@Service
@RequiredArgsConstructor
public class PetService extends ServiceImpl<PetMapper, Pet> {

    private final SysUserMapper sysUserMapper;

    /** 用户端"我的宠物"列表，预约下单时选的就是这个 */
    public List<Pet> listMine() {
        return list(Wrappers.<Pet>lambdaQuery()
                .eq(Pet::getUserId, UserContext.requireId())
                .orderByDesc(Pet::getCreateTime)).stream().map(this::currentAge).toList();
    }

    @Transactional
    public Pet create(PetForm form) {
        validate(form);
        Pet pet = new Pet();
        pet.setUserId(UserContext.requireId());
        pet.setName(form.getName());
        pet.setSpecies(form.getSpecies());
        pet.setBreed(form.getBreed());
        pet.setGender(form.getGender());
        pet.setBirthday(form.getBirthday());
        pet.setAgeMonth(deriveAgeMonth(form.getBirthday(), form.getAgeMonth()));
        pet.setWeight(form.getWeight());
        pet.setColor(form.getColor());
        pet.setIsNeutered(form.getIsNeutered());
        pet.setVaccineStatus(form.getVaccineStatus());
        pet.setDewormFlag(form.getDewormFlag());
        pet.setAvatar(form.getAvatar());
        pet.setAllergy(form.getAllergy());
        pet.setMedicalHistory(form.getMedicalHistory());
        pet.setRemark(form.getRemark());
        save(pet);
        return pet;
    }

    @Transactional
    public void update(Long id, PetForm form) {
        updateExisting(id, requireOwned(id), form);
    }

    /**
     * 逻辑删除。历史预约、病历、问诊的宠物信息由 {@code PetMapper.selectHistoryDisplay}
     * 历史查询补齐（含已删档案），删档案不会让旧记录显示不出宠物；
     * 档案列表与新建预约/问诊仍查不到它。
     * 注意：历史记录显示的是档案最后保存的信息，不是就诊当时的名称快照——改名会跟着变。
     */
    @Transactional
    public void remove(Long id) {
        requireOwned(id);
        removeById(id);
    }

    /** 归属校验放服务端：userId 一律不接受前端传值 */
    public Pet requireOwned(Long id) {
        Pet pet = getById(id);
        if (pet == null || !pet.getUserId().equals(UserContext.requireId())) {
            throw BizException.notFound("宠物档案");
        }
        return pet;
    }

    /** 后台：某用户的全部宠物（用户详情页用，不校验登录人） */
    public List<Pet> listByUser(Long userId) {
        return list(Wrappers.<Pet>lambdaQuery()
                .eq(Pet::getUserId, userId)
                .orderByDesc(Pet::getCreateTime)).stream().map(this::currentAge).toList();
    }

    /** 后台宠物分页：关键字命中宠物名或主人昵称/手机号 */
    public PageResult<PetVo> pageForAdmin(PetQuery q) {
        String kw = q.getKeyword() == null || q.getKeyword().isBlank() ? null : q.getKeyword().trim();
        LambdaQueryWrapper<Pet> qw = Wrappers.<Pet>lambdaQuery();
        if (kw != null) {
            List<Long> ownerIds = sysUserMapper.selectList(Wrappers.<SysUser>lambdaQuery()
                            .like(SysUser::getNickname, kw)
                            .or().like(SysUser::getPhone, kw))
                    .stream().map(SysUser::getId).toList();
            qw.and(w -> w.like(Pet::getName, kw).or(!ownerIds.isEmpty(), x -> x.in(Pet::getUserId, ownerIds)));
        }
        qw.orderByDesc(Pet::getCreateTime);
        Page<Pet> page = page(new Page<>(q.getPageNum(), q.getPageSize()), qw);

        Map<Long, SysUser> owners = BatchLookup.mapByIds(sysUserMapper::selectBatchIds,
                BatchLookup.ids(page.getRecords(), Pet::getUserId), SysUser::getId);
        List<PetVo> rows = page.getRecords().stream().map(p -> {
            currentAge(p);
            PetVo vo = new PetVo();
            BeanUtils.copyProperties(p, vo);
            SysUser owner = owners.get(p.getUserId());
            if (owner != null) {
                vo.setUserNickname(owner.getNickname());
                vo.setUserPhone(owner.getPhone());
            }
            return vo;
        }).toList();
        return PageResult.of(page, rows);
    }

    /** 后台纠正档案：不校验归属，其余校验与用户端一致 */
    @Transactional
    public void updateByAdmin(Long id, PetForm form) {
        Pet own = getById(id);
        if (own == null) {
            throw BizException.notFound("宠物档案");
        }
        updateExisting(id, own, form);
    }

    /** 两个更新入口共用的写入步骤；归属/存在性校验由调用方完成后把原记录传进来 */
    private void updateExisting(Long id, Pet own, PetForm form) {
        validate(form);
        Pet row = new Pet();
        row.setId(id);
        row.setUserId(own.getUserId());
        row.setName(form.getName());
        row.setSpecies(form.getSpecies());
        row.setBreed(form.getBreed());
        row.setGender(form.getGender());
        row.setBirthday(form.getBirthday());
        row.setWeight(form.getWeight());
        row.setColor(form.getColor());
        row.setIsNeutered(form.getIsNeutered());
        row.setVaccineStatus(form.getVaccineStatus());
        row.setDewormFlag(form.getDewormFlag());
        row.setAvatar(form.getAvatar());
        row.setAllergy(form.getAllergy());
        row.setMedicalHistory(form.getMedicalHistory());
        row.setRemark(form.getRemark());
        LocalDate birthday = form.isBirthdaySubmitted() ? form.getBirthday() : own.getBirthday();
        row.setAgeMonth(deriveAgeMonth(birthday, form.getAgeMonth() == null ? own.getAgeMonth() : form.getAgeMonth()));
        // 省略字段由 MP 的 NOT_NULL 策略保留；显式 null 必须写进 SET 才能清空
        update(row, Wrappers.<Pet>lambdaUpdate().eq(Pet::getId, id)
                .set(form.isBirthdaySubmitted(), Pet::getBirthday, form.getBirthday())
                .set(form.isWeightSubmitted(), Pet::getWeight, form.getWeight()));
    }

    /** 后台逻辑删除（处理重复录入）。历史记录的宠物显示同 remove：走含已删档案的历史查询，不受影响 */
    @Transactional
    public void removeByAdmin(Long id) {
        if (getById(id) == null) {
            throw BizException.notFound("宠物档案");
        }
        removeById(id);
    }

    private void validate(PetForm form) {
        if (form.getName() == null || form.getName().isBlank()) {
            throw new BizException("请填写宠物昵称");
        }
        if (form.getName().length() > 20) {
            throw new BizException("宠物昵称不超过 20 字");
        }
        if (form.getSpecies() == null || form.getSpecies().isBlank()) {
            throw new BizException("请选择宠物种类");
        }
    }

    /**
     * 有生日就以生日为准算月龄，避免用户在表单里填了生日又手填一个对不上的月龄。
     * 没填生日时保留前端传来的月龄。
     */
    static Integer deriveAgeMonth(LocalDate birthday, Integer manualAge) {
        if (birthday == null) {
            if (manualAge != null && (manualAge < 0 || manualAge > 360)) throw new BizException("月龄须在 0～360 之间");
            return manualAge;
        }
        if (birthday.isAfter(LocalDate.now())) {
            throw new BizException("出生日期不能晚于今天");
        }
        return (int) ChronoUnit.MONTHS.between(birthday, LocalDate.now());
    }

    private Pet currentAge(Pet pet) {
        pet.setAgeMonth(deriveAgeMonth(pet.getBirthday(), pet.getAgeMonth()));
        return pet;
    }
}
